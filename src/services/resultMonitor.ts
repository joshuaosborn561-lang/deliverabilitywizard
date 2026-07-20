import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  normalizeTestList,
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  testIdOf,
  uniqueBlacklistedDomains,
} from "../clients/smartdelivery.js";
import type { StateStore } from "../state/store.js";
import type {
  BlacklistedDomainHit,
  MailboxSummaryRow,
  SpamTestSummary,
} from "../types/index.js";

export interface MonitorResult {
  testsChecked: number;
  blacklistAlerts: number;
  lowDeliverabilityAlerts: number;
  errors: string[];
}

export class ResultMonitor {
  constructor(
    private readonly config: AppConfig,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(): Promise<MonitorResult> {
    const result: MonitorResult = {
      testsChecked: 0,
      blacklistAlerts: 0,
      lowDeliverabilityAlerts: 0,
      errors: [],
    };

    console.log("[monitor] Starting result monitoring");

    let tests: SpamTestSummary[] = [];
    try {
      const raw = await this.smartDelivery.listTests({});
      tests = normalizeTestList(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`listTests: ${message}`);
      this.state.setLastMonitorAt(new Date().toISOString());
      await this.state.save();
      return result;
    }

    // Prefer tests we created; also check recent completed tests so nothing is missed.
    const trackedIds = new Set(
      Object.values(this.state.get().testedCampaigns).flatMap((c) => c.testIds),
    );

    const interesting = tests.filter((test) => {
      const id = testIdOf(test);
      if (!id) return false;
      const status = String(test.status ?? "").toLowerCase();
      const completed =
        status.includes("complete") ||
        status.includes("done") ||
        status.includes("finished") ||
        status === "active" ||
        status === "";
      return trackedIds.has(id) || completed;
    });

    // Cap work per run to stay within rate limits
    const toCheck = interesting.slice(0, 40);
    result.testsChecked = toCheck.length;

    for (const test of toCheck) {
      const testId = testIdOf(test);
      if (!testId) continue;
      try {
        result.blacklistAlerts += await this.checkBlacklists(
          testId,
          test.test_name,
        );
        result.lowDeliverabilityAlerts += await this.checkProviderDeliverability(
          testId,
          test.test_name,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`test ${testId}: ${message}`);
      }
    }

    try {
      result.lowDeliverabilityAlerts += await this.checkMailboxSummary();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`mailbox-summary: ${message}`);
    }

    this.state.setLastMonitorAt(new Date().toISOString());
    await this.state.save();
    console.log("[monitor] Done", result);
    return result;
  }

  private async checkBlacklists(
    testId: string,
    testName?: string,
  ): Promise<number> {
    const domainRaw = await this.smartDelivery
      .getDomainBlacklist(testId)
      .catch(() => []);
    const ipRaw = await this.smartDelivery.getIpBlacklist(testId).catch(() => []);

    const hits: BlacklistedDomainHit[] = [
      ...parseDomainBlacklistHits(domainRaw),
      ...parseIpBlacklistHits(ipRaw),
    ];

    if (!hits.length) return 0;

    const domains = uniqueBlacklistedDomains(hits);
    // Deduped per test+domain set so Slack clearly names every blacklisted domain once.
    const key = `blacklist-domains:v2:${testId}:${domains.map((d) => d.toLowerCase()).sort().join(",")}`;
    if (this.state.hasAlert(key)) return 0;

    await this.slack.notifyBlacklistedDomains({
      testId,
      testName,
      domains,
      hits,
    });
    this.state.markAlert(key);

    console.log(
      `[monitor] Blacklisted domains on test ${testId}: ${domains.join(", ")}`,
    );
    return 1;
  }

  private async checkProviderDeliverability(
    testId: string,
    testName?: string,
  ): Promise<number> {
    let alerts = 0;
    const report = await this.smartDelivery.getProviderwiseReport(testId);
    const rows = report.result ?? [];
    for (const row of rows) {
      const score = providerInboxRate(row);
      if (score === undefined) continue;
      if (score >= this.config.deliverabilityThreshold) continue;

      const label =
        row.provider_name || row.provider || String(row.provider_id ?? "unknown provider");
      const key = `low-inbox:v2:${testId}:${label}:${Math.floor(score)}`;
      if (this.state.hasAlert(key)) continue;

      await this.slack.notifyLowDeliverability({
        label,
        score,
        threshold: this.config.deliverabilityThreshold,
        context: testName
          ? `Test: *${testName}* (\`${testId}\`)`
          : `Test: \`${testId}\``,
      });
      this.state.markAlert(key);
      alerts += 1;
    }
    return alerts;
  }

  private async checkMailboxSummary(): Promise<number> {
    let alerts = 0;
    const rows: MailboxSummaryRow[] = await this.smartDelivery.getMailboxSummary();
    if (!Array.isArray(rows)) return 0;

    for (const row of rows) {
      const score =
        typeof row.placement_score === "number"
          ? row.placement_score
          : computePlacementScore(row);
      if (score === undefined) continue;
      if (score >= this.config.deliverabilityThreshold) continue;

      const label = `${row.from_email ?? "unknown"} / ${row.esp ?? "inbox"}`;
      const key = `low-mailbox:${row.id ?? label}:${Math.floor(score)}`;
      if (this.state.hasAlert(key)) continue;

      await this.slack.notifyLowDeliverability({
        label,
        score,
        threshold: this.config.deliverabilityThreshold,
        context: row.spam_test_id
          ? `SmartDelivery mailbox summary (test \`${row.spam_test_id}\`)`
          : "SmartDelivery mailbox summary",
      });
      this.state.markAlert(key);
      alerts += 1;
    }
    return alerts;
  }
}

function computePlacementScore(row: MailboxSummaryRow): number | undefined {
  const total = row.total_email_count;
  const inbox = row.inbox_count;
  if (typeof total === "number" && total > 0 && typeof inbox === "number") {
    return (inbox / total) * 100;
  }
  return undefined;
}

/** SmartDelivery providerwise may return inbox_rate OR inbox_count/total counts. */
function providerInboxRate(row: {
  inbox_rate?: number;
  inbox_count?: number;
  spam_count?: number;
  tab_count?: number;
  adjusted_total_email_count?: number;
  total_email_count?: number;
  mailbox_count?: number;
}): number | undefined {
  if (typeof row.inbox_rate === "number") return row.inbox_rate;

  const inbox = row.inbox_count;
  if (typeof inbox !== "number") return undefined;

  const total =
    (typeof row.adjusted_total_email_count === "number" &&
    row.adjusted_total_email_count > 0
      ? row.adjusted_total_email_count
      : undefined) ??
    (typeof row.total_email_count === "number" && row.total_email_count > 0
      ? row.total_email_count
      : undefined) ??
    (typeof row.mailbox_count === "number" && row.mailbox_count > 0
      ? row.mailbox_count
      : undefined) ??
    ([inbox, row.spam_count, row.tab_count]
      .filter((n): n is number => typeof n === "number")
      .reduce((a, b) => a + b, 0) || undefined);

  if (!total || total <= 0) return undefined;
  return (inbox / total) * 100;
}
