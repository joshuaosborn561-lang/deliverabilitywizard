import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  normalizeTestList,
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  parseSenderInboxRates,
  testIdOf,
  uniqueBlacklistedDomains,
} from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  pickSequence,
  sequenceSubjectPreview,
} from "../clients/smartlead.js";
import { isMissingSpamTestNoise } from "../lib/alertNoise.js";
import { prioritizeTestIdsForReports } from "../lib/testIdPriority.js";
import {
  dkimFailing,
  parseSenderAuthResults,
  spfFailing,
} from "../lib/authResults.js";
import {
  diagnoseBlacklists,
  filterTeardownBlacklistHits,
} from "../lib/blacklistDiagnosis.js";
import {
  formatSpamCopySlackLines,
  suggestSpamCopyChanges,
} from "../lib/spamCopyHints.js";
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
  /**
   * Smartlead account types (email → GMAIL/OUTLOOK/…), needed so alerts score
   * the same way remediation does. Fetched at most once per run, and only when
   * an alert actually needs it — a clean run never pays for it.
   */
  private senderTypes: Map<string, string | undefined> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  /**
   * Without this map `parseSenderInboxRates` sees every sender as ESP "other",
   * which forces blended scoring — so the alert would quote a different number
   * than the one remediation acts on. Failure is non-fatal: we fall back to
   * blended and the alert still goes out, just labelled as blended.
   */
  private async getSenderTypes(): Promise<Map<string, string | undefined>> {
    if (this.senderTypes) return this.senderTypes;
    const map = new Map<string, string | undefined>();
    try {
      const accounts = await this.smartlead.listAllEmailAccounts();
      for (const account of accounts) {
        const email = accountEmail(account)?.toLowerCase();
        if (email) map.set(email, account.type);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[monitor] Could not load Smartlead account types (${message}) — alerts fall back to blended ESP scoring`,
      );
    }
    this.senderTypes = map;
    return map;
  }

  async run(): Promise<MonitorResult> {
    // Types can change between runs (new mailboxes, reconnects) — refetch.
    this.senderTypes = null;
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
    const trackedIds = [
      ...new Set(
        Object.values(this.state.get().testedCampaigns).flatMap((c) => c.testIds),
      ),
    ];
    const listedIds = tests
      .map((test) => testIdOf(test))
      .filter((id): id is string => Boolean(id));
    const prioritizedIds = prioritizeTestIdsForReports({
      trackedIds: [...trackedIds, ...listedIds],
      listedTests: tests,
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
          test?.test_name,
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

  private async checkProviderDeliverability(
    testId: string,
    testName?: string,
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

    const weak = providers.filter(
      (p) => p.inboxPercent < this.config.deliverabilityThreshold,
    );
    if (!weak.length) return 0;

    // One alert per test (not per provider) — keyed on rounded weak scores
    const key = `low-inbox:v4:${testId}:${weak
      .map((p) => `${p.name}:${Math.floor(p.inboxPercent)}`)
      .sort()
      .join("|")}`;
    if (this.state.hasAlert(key)) return 0;

    // Per-sender placement + SPF/DKIM, so the alert says which mailbox is bad
    // and why — not just that a provider is weak.
    let senders: Array<{
      email: string;
      inboxPercent: number;
      scoredSameEsp?: boolean;
      willRemediate?: boolean;
    }> = [];
    let authFailures: Array<{
      email: string;
      spfFailing: boolean;
      dkimFailing: boolean;
    }> = [];
    try {
      const senderRaw = await this.smartDelivery.getSenderAccountReport(testId);
      senders = parseSenderInboxRates(senderRaw, testId, {
        senderTypeByEmail: await this.getSenderTypes(),
        preferSameEsp: this.config.scoreSameEspOnly,
        minSameEspSamples: this.config.minSameEspSamples,
      }).map((row) => ({
        email: row.email,
        inboxPercent: row.inboxRate,
        scoredSameEsp: row.scoredSameEsp,
        // D32: Slack "will remediate" must match rotation — same-ESP only.
        willRemediate:
          this.config.enableRemediation &&
          row.scoredSameEsp === true &&
          row.inboxRate < this.config.remediationInboxThreshold,
      }));
      authFailures = parseSenderAuthResults(senderRaw)
        .map((row) => ({
          email: row.email,
          spfFailing: spfFailing(row),
          dkimFailing: dkimFailing(row),
        }))
        .filter((row) => row.spfFailing || row.dkimFailing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[monitor] sender detail for ${testId} failed: ${message}`);
    }

    const overall = overallSplit(rows);
    const campaign = await this.resolveCampaignForTest(testId);
    const copy = campaign
      ? await this.buildCopyAdvice(campaign.id, campaign.name, overall?.spamPercent)
      : {
          copyHints: [] as ReturnType<typeof suggestSpamCopyChanges>,
          copyAdviceLines: formatSpamCopySlackLines({
            campaignName: testName,
            hints: [],
            spamPercent: overall?.spamPercent,
          }),
          sequenceSubject: undefined as string | undefined,
        };

    await this.slack.notifyPlacementResult({
      testName,
      testId,
      campaignId: campaign?.id,
      campaignName: campaign?.name,
      sequenceSubject: copy.sequenceSubject,
      copyHints: copy.copyHints,
      copyAdviceLines: copy.copyAdviceLines,
      threshold: this.config.deliverabilityThreshold,
      providers,
      autoRemediation: this.config.enableRemediation,
      overall,
      senders,
      authFailures,
      remediationThreshold: this.config.remediationInboxThreshold,
      holdDays: this.config.recoveryHoldDays,
    });
    this.state.markAlert(key);
    console.log(
      `[monitor] Placement alert for test ${testId}: ${weak
        .map((p) => `${p.name} ${p.inboxPercent.toFixed(1)}%`)
        .join(", ")}`,
    );
    return 1;
  }

  /**
   * Map a SmartDelivery test back to its Smartlead campaign (state first,
   * then test details). Needed so spam alerts name the campaign and we can
   * pull sequence copy for change suggestions.
   */
  private async resolveCampaignForTest(
    testId: string,
  ): Promise<{ id: number; name: string } | null> {
    const tested = this.state.get().testedCampaigns ?? {};
    for (const [campaignId, record] of Object.entries(tested)) {
      if (!record?.testIds?.map(String).includes(String(testId))) continue;
      const id = Number(campaignId);
      if (!Number.isFinite(id)) continue;
      return {
        id,
        name: record.campaignName || `Campaign ${id}`,
      };
    }

    try {
      const details = await this.smartDelivery.getTestDetails(testId);
      const raw = details.campaign_id ?? details.campaignId;
      const id = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(id) || id <= 0) return null;
      let name = String(
        details.campaign_name ?? details.campaignName ?? `Campaign ${id}`,
      );
      try {
        const campaign = await this.smartlead.getCampaign(id);
        if (campaign?.name) name = campaign.name;
      } catch {
        // Name from details is fine.
      }
      return { id, name };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[monitor] Could not resolve campaign for test ${testId}: ${message}`,
      );
      return null;
    }
  }

  private async buildCopyAdvice(
    campaignId: number,
    campaignName: string,
    spamPercent?: number,
  ): Promise<{
    sequenceSubject?: string;
    copyHints: ReturnType<typeof suggestSpamCopyChanges>;
    copyAdviceLines: string[];
  }> {
    let sequenceSubject: string | undefined;
    let bodyHtml: string | undefined;
    try {
      const sequences = await this.smartlead.getCampaignSequences(campaignId);
      const sequence = pickSequence(sequences ?? [], this.config.sequenceNumber);
      if (sequence) {
        sequenceSubject = sequenceSubjectPreview(sequence);
        const variant =
          sequence.sequence_variants?.[0] ?? sequence.variants?.[0];
        bodyHtml =
          sequence.email_body ||
          variant?.email_body ||
          undefined;
        if (!sequence.subject && variant?.subject) {
          sequenceSubject = variant.subject;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[monitor] sequence fetch for campaign ${campaignId} failed: ${message}`,
      );
    }

    const copyHints = suggestSpamCopyChanges({
      subject: sequenceSubject,
      bodyHtml,
    });
    return {
      sequenceSubject,
      copyHints,
      copyAdviceLines: formatSpamCopySlackLines({
        campaignId,
        campaignName,
        subject: sequenceSubject,
        hints: copyHints,
        spamPercent,
      }),
    };
  }

  private async checkMailboxSummary(): Promise<number> {
    // Provider-level alerts already cover campaign placement in plain English.
    // Skip the noisy per-mailbox summary channel unless remediation is off
    // (then the human needs the heads-up).
    if (this.config.enableRemediation) return 0;

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
