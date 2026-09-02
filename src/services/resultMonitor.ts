import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  campaignIdOf,
  normalizeTestList,
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  testIdOf,
  uniqueBlacklistedDomains,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { isMissingSpamTestNoise } from "../lib/alertNoise.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import {
  diagnoseBlacklists,
  filterTeardownBlacklistHits,
} from "../lib/blacklistDiagnosis.js";
import {
  liveCampaignForPlacementTrigger,
  placementSuspectReason,
  sameEspInboxUgly,
  shouldQueuePlacementSuspect,
} from "../lib/placementSuspect.js";
import { prioritizeTestIdsForReports } from "../lib/testIdPriority.js";
import type { StateStore } from "../state/store.js";
import type {
  BlacklistedDomainHit,
  MailboxSummaryRow,
  SmartleadCampaign,
  SpamTestSummary,
} from "../types/index.js";
import { isExcluded } from "./campaignTopUp.js";

export interface MonitorResult {
  testsChecked: number;
  blacklistAlerts: number;
  lowDeliverabilityAlerts: number;
  errors: string[];
}

export class ResultMonitor {
  /** ACTIVE/PAUSED campaign book for mapping canary-copy tests to live ids. */
  private campaigns: SmartleadCampaign[] | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(): Promise<MonitorResult> {
    this.campaigns = null;
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
    // D158 — copy-canary ids live under isolation.copyCanaries, not testedCampaigns.
    const campaigns = await this.getCampaigns();
    const canaryIds = this.state.listCopyCanaryTestIds();
    const activeLiveIds = new Set(
      campaigns
        .filter(
          (row) =>
            String(row.status ?? "").toUpperCase() === "ACTIVE" &&
            !isAnyShellCampaign(row),
        )
        .map((row) => String(row.id)),
    );
    const liveTestIds = Object.entries(this.state.get().testedCampaigns)
      .filter(([campaignId]) => activeLiveIds.has(campaignId))
      .flatMap(([, row]) => row.testIds);
    const trackedIds = [
      ...new Set([
        ...Object.values(this.state.get().testedCampaigns).flatMap(
          (c) => c.testIds,
        ),
        ...canaryIds,
      ]),
    ];
    const listedIds = tests
      .map((test) => testIdOf(test))
      .filter((id): id is string => Boolean(id));
    const prioritizedIds = prioritizeTestIdsForReports({
      trackedIds: [...trackedIds, ...listedIds],
      listedTests: tests,
      priorityIds: [...liveTestIds, ...canaryIds],
    });
    const testById = new Map(
      tests
        .map((test) => [testIdOf(test), test] as const)
        .filter((row): row is [string, (typeof tests)[number]] => Boolean(row[0])),
    );

    result.testsChecked = prioritizedIds.length;

    for (const testId of prioritizedIds) {
      const test = testById.get(testId);
      try {
        result.blacklistAlerts += await this.checkBlacklists(
          testId,
          test?.test_name,
        );
        result.lowDeliverabilityAlerts += await this.checkProviderDeliverability(
          testId,
          test,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Tracked ids can outlive the SmartDelivery record (stopped/purged).
        // Skip quietly — not an actionable failure and not a stale endpoint.
        if (isMissingSpamTestNoise(message)) {
          console.warn(
            `[monitor] Test ${testId} no longer exists in SmartDelivery — skipping`,
          );
          continue;
        }
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
    // SURBL / unnamed domain-blacklist noise — do not page Slack for teardown.
    const actionableHits = filterTeardownBlacklistHits(hits);

    if (!actionableHits.length) {
      if (hits.length) {
        console.log(
          `[monitor] Ignoring ${hits.length} SURBL/unnamed domain-blacklist hit(s) on test ${testId}`,
        );
      }
      return 0;
    }

    const domains = uniqueBlacklistedDomains(actionableHits);
    // Deduped per test+domain set so Slack clearly names every blacklisted domain once.
    const key = `blacklist-domains:v4:${testId}:${domains.map((d) => d.toLowerCase()).sort().join(",")}`;
    if (this.state.hasAlert(key)) return 0;

    const diagnoses = diagnoseBlacklists(actionableHits);

    await this.slack.notifyBlacklistDiagnosis({
      testId,
      testName,
      diagnoses,
    });
    this.state.markAlert(key);

    console.log(
      `[monitor] Blacklisted domains on test ${testId}:`,
      diagnoses.map((d) => `${d.domain}=${d.verdict}`).join(", "),
    );
    return 1;
  }

  private async getCampaigns(): Promise<SmartleadCampaign[]> {
    if (this.campaigns) return this.campaigns;
    try {
      this.campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[monitor] Could not list campaigns (${message}) — placement isolation queue skipped this pass`,
      );
      this.campaigns = [];
    }
    return this.campaigns;
  }

  private async checkProviderDeliverability(
    testId: string,
    test?: SpamTestSummary,
  ): Promise<number> {
    const report = await this.smartDelivery.getProviderwiseReport(testId);
    const rows = report.result ?? [];
    const providers: Array<{ name: string; inboxPercent: number }> = [];
    for (const row of rows) {
      const score = providerInboxRate(row);
      if (score === undefined) continue;
      const label =
        row.provider_name ||
        row.provider ||
        String(row.provider_id ?? "unknown provider");
      providers.push({ name: label, inboxPercent: score });
    }

    // D158 — live 80% same-ESP queues isolation. D162 pages Slack from
    // the health-pass CANON-miss pager (once per campaign per incident).
    if (!sameEspInboxUgly(providers, this.config.remediationInboxThreshold)) {
      return 0;
    }

    const campaigns = await this.getCampaigns();
    let target = liveCampaignForPlacementTrigger({
      testName: test?.test_name,
      testCampaignId: test ? campaignIdOf(test) : undefined,
      campaigns,
    });
    if (!target) {
      const canaryCampaignId = this.state.campaignIdForCopyCanaryTestId(testId);
      if (canaryCampaignId != null) {
        target = liveCampaignForPlacementTrigger({
          testName: `Canary copy: #${canaryCampaignId}`,
          campaigns,
        });
      }
    }
    if (!target) {
      console.log(
        `[monitor] Same-ESP under ${this.config.remediationInboxThreshold}% on test ${testId} (${test?.test_name ?? "unnamed"}) — no ACTIVE live campaign to queue`,
      );
      return 0;
    }
    const campaign = campaigns.find((row) => row.id === target.campaignId);
    if (
      campaign &&
      (isExcluded(campaign, this.config.topUpExcludeCampaigns) ||
        isAnyShellCampaign(campaign))
    ) {
      return 0;
    }

    const existing = this.state
      .listCopySuspects()
      .find((row) => row.campaignId === target.campaignId);
    const openRun = this.state.latestIsolationRunForCampaign(target.campaignId);
    if (!shouldQueuePlacementSuspect({ existing, openRun })) {
      return 0;
    }

    this.state.markCopySuspect({
      campaignId: target.campaignId,
      campaignName: target.campaignName,
      at: new Date().toISOString(),
      reason: placementSuspectReason(
        target.source,
        providers,
        this.config.remediationInboxThreshold,
      ),
      evaluatedAt: undefined,
    });
    console.log(
      `[monitor] Queued isolation for #${target.campaignId} from ${target.source}: ${providers
        .filter((p) => p.inboxPercent < this.config.remediationInboxThreshold)
        .map((p) => `${p.name} ${p.inboxPercent.toFixed(1)}%`)
        .join(", ")}`,
    );
    return 1;
  }

  private async checkMailboxSummary(): Promise<number> {
    // Provider-level alerts already cover campaign placement in plain
    // English; this per-mailbox summary is a log-side reading (D51/D71).

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
          ? `Mailbox summary (test \`${row.spam_test_id}\`)`
          : "Mailbox summary",
      });
      this.state.markAlert(key);
      alerts += 1;
    }
    return alerts;
  }
}

/** Aggregate inbox/tab/spam across every provider row in a test. */
export function overallSplit(
  rows: Array<{
    inbox_count?: number;
    tab_count?: number;
    spam_count?: number;
  }>,
):
  | { inboxPercent: number; tabPercent: number; spamPercent: number }
  | undefined {
  let inbox = 0;
  let tab = 0;
  let spam = 0;
  for (const row of rows) {
    inbox += typeof row.inbox_count === "number" ? row.inbox_count : 0;
    tab += typeof row.tab_count === "number" ? row.tab_count : 0;
    spam += typeof row.spam_count === "number" ? row.spam_count : 0;
  }
  const total = inbox + tab + spam;
  if (total <= 0) return undefined;
  return {
    inboxPercent: (inbox / total) * 100,
    tabPercent: (tab / total) * 100,
    spamPercent: (spam / total) * 100,
  };
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
