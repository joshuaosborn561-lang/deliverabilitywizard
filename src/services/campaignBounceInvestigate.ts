import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  normalizeTestList,
  campaignIdOf,
  testIdOf,
} from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { ProviderwiseRow, SmartleadCampaign } from "../types/index.js";
import {
  parseSenderBounceStats,
  shouldRotateForBounces,
} from "../lib/bounceRate.js";
import { isExcluded } from "./campaignTopUp.js";
import {
  classifyCopySignal,
  shouldDeferSenderRotationForCopy,
  type ProviderInboxSplit,
} from "../lib/copySignal.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";

/**
 * D29 / D40 — When a campaign is PAUSED and its senders' aggregate bounce is
 * over the investigate threshold (default 7%), dig in: if placement says the
 * *copy* is the problem, Slack and leave senders alone; otherwise rotate the
 * worst bouncing senders. Do **not** auto-START — a manual pause must stay
 * paused (D40). Protective system pauses resume only via health + pendingResumes.
 */

export interface BounceInvestigateFinding {
  campaignId: number;
  campaignName: string;
  aggregateBouncePercent: number;
  sampleSent: number;
  copyDefer: boolean;
  copyReason?: string;
  rotated: string[];
  resumed: boolean;
  errors: string[];
}

export interface BounceInvestigateResult {
  dryRun: boolean;
  scannedPaused: number;
  findings: BounceInvestigateFinding[];
  errors: string[];
}

function inboxPercentFromProvider(row: ProviderwiseRow): number | null {
  if (typeof row.inbox_rate === "number" && Number.isFinite(row.inbox_rate)) {
    return row.inbox_rate <= 1 ? row.inbox_rate * 100 : row.inbox_rate;
  }
  const inbox = row.inbox_count ?? 0;
  const tab = row.tab_count ?? 0;
  const spam = row.spam_count ?? 0;
  const total =
    row.adjusted_total_email_count ??
    row.total_email_count ??
    inbox + tab + spam;
  if (!total) return null;
  return (inbox / total) * 100;
}

async function providerSplitsForCampaign(
  smartDelivery: SmartDeliveryClient,
  campaignId: number,
): Promise<ProviderInboxSplit[]> {
  try {
    const listed = normalizeTestList(await smartDelivery.listTests({}));
    const enriched = await smartDelivery.enrichCampaignIds(listed);
    const test = enriched.find((t) => Number(campaignIdOf(t)) === campaignId);
    const tid = test ? testIdOf(test) : null;
    if (!tid) return [];
    const report = await smartDelivery.getProviderwiseReport(tid);
    const rows = Array.isArray(report.result) ? report.result : [];
    const out: ProviderInboxSplit[] = [];
    for (const row of rows) {
      const name = String(row.provider_name ?? row.provider ?? "");
      const inbox = inboxPercentFromProvider(row);
      if (!name || inbox == null) continue;
      out.push({ name, inboxPercent: inbox });
    }
    return out;
  } catch {
    return [];
  }
}

export class CampaignBounceInvestigateService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<BounceInvestigateResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: BounceInvestigateResult = {
      dryRun,
      scannedPaused: 0,
      findings: [],
      errors: [],
    };
    const threshold = this.config.campaignBounceInvestigateThreshold;

    const [campaigns, accounts] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
    ]);

    let bounceByEmail = new Map<string, { bounceRate: number; sent: number }>();
    try {
      const raw = await this.smartlead.getMailboxHealthMetrics({});
      for (const row of parseSenderBounceStats(raw)) {
        bounceByEmail.set(row.email.toLowerCase(), {
          bounceRate: row.bounceRate,
          sent: row.sent,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`bounce stats: ${message}`);
      return result;
    }

    const paused = (campaigns as SmartleadCampaign[]).filter(
      (c) => String(c.status ?? "").toUpperCase() === "PAUSED",
    );
    result.scannedPaused = paused.length;

    for (const campaign of paused) {
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      // Our own last-account protective pauses are resumed by health staffing.
      const pending = this.state.getPendingResume(campaign.id);
      if (pending?.reason?.includes("last_account")) continue;

      const members = (accounts as SmartleadAccountWithCampaigns[]).filter(
        (a) => campaignIdsOf(a).includes(campaign.id),
      );
      let bounceWeighted = 0;
      let sentTotal = 0;
      const badSenders: Array<{
        email: string;
        accountId: number;
        rate: number;
        sent: number;
      }> = [];

      for (const account of members) {
        const email = accountEmail(account)?.toLowerCase();
        if (!email) continue;
        const stats = bounceByEmail.get(email);
        if (!stats || stats.sent <= 0) continue;
        bounceWeighted += (stats.bounceRate / 100) * stats.sent;
        sentTotal += stats.sent;
        if (
          shouldRotateForBounces(
            {
              email,
              bounceRate: stats.bounceRate,
              sent: stats.sent,
            },
            threshold,
            this.config.minBounceSample,
          )
        ) {
          badSenders.push({
            email,
            accountId: account.id,
            rate: stats.bounceRate,
            sent: stats.sent,
          });
        }
      }

      if (sentTotal < this.config.minBounceSample) continue;
      const aggregate = (bounceWeighted / sentTotal) * 100;
      if (aggregate < threshold) continue;

      const providers = await providerSplitsForCampaign(
        this.smartDelivery,
        campaign.id,
      );
      const copy = classifyCopySignal(
        providers,
        this.config.remediationInboxThreshold,
      );
      const copyDefer = shouldDeferSenderRotationForCopy(copy);

      const finding: BounceInvestigateFinding = {
        campaignId: campaign.id,
        campaignName: String(campaign.name ?? campaign.id),
        aggregateBouncePercent: aggregate,
        sampleSent: sentTotal,
        copyDefer,
        copyReason: copy.kind !== "none" ? copy.reason : undefined,
        rotated: [],
        resumed: false,
        errors: [],
      };

      if (copyDefer) {
        this.state.markCopySuspect({
          campaignId: campaign.id,
          campaignName: finding.campaignName,
          at: new Date().toISOString(),
        });
        result.findings.push(finding);
        continue;
      }

      badSenders.sort((a, b) => b.rate - a.rate);
      for (const bad of badSenders.slice(0, 25)) {
        try {
          if (!dryRun) {
            await this.smartlead.removeEmailAccountsFromCampaign(campaign.id, [
              bad.accountId,
            ]);
            await this.smartlead.configureWarmup(bad.accountId, {
              warmup_enabled: true,
              total_warmup_per_day: this.config.warmupTotalPerDay,
              daily_rampup: this.config.warmupDailyRampup,
              reply_rate_percentage: this.config.warmupReplyRatePercentage,
            });
            await sleep(250);
          }
          finding.rotated.push(`${bad.email} (${bad.rate.toFixed(1)}%)`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          finding.errors.push(`rotate ${bad.email}: ${message}`);
        }
      }

      try {
        // D40 — never auto-START here. Manual pauses must stay paused; only
        // health may resume campaigns we ourselves marked in pendingResumes.
        const remaining = await this.smartlead.getCampaignEmailAccounts(
          campaign.id,
        );
        if (remaining.length === 0) {
          finding.errors.push("no senders left after rotation");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finding.errors.push(`post-rotate check: ${message}`);
      }

      result.findings.push(finding);
    }

    const slackFindings = result.findings.filter((f) => !f.copyDefer);
    if (slackFindings.length) {
      const lines = [
        `${dryRun ? "Preview — " : ""}Paused campaign — high bounce (over ${threshold}%):`,
      ];
      for (const f of slackFindings) {
        lines.push(
          `• ${f.campaignName}: ${f.aggregateBouncePercent.toFixed(1)}% bounce — swapped out ${f.rotated.length} worst inbox${f.rotated.length === 1 ? "" : "es"}. Campaign stays paused until someone turns it back on.`,
        );
      }
      try {
        await this.slack.send(lines.join("\n"));
      } catch (error) {
        console.warn("[bounce-investigate] Slack notify failed", error);
      }
    }

    console.log(
      `[bounce-investigate] paused=${result.scannedPaused} findings=${result.findings.length}`,
    );
    return result;
  }
}
