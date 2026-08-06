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
import {
  classifyCopySignal,
  shouldDeferSenderRotationForCopy,
  type ProviderInboxSplit,
} from "../lib/copySignal.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";

/**
 * D29 — When a campaign is PAUSED and its senders' aggregate bounce is over
 * the investigate threshold (default 7%), dig in: if placement says the
 * *copy* is the problem, Slack and leave senders alone; otherwise rotate the
 * worst bouncing senders and try to get the campaign sendable again.
 */

export interface BounceInvestigateFinding {
  campaignId: number;
  campaignName: string;
  aggregateBouncePercent: number;
  sampleSent: number;
  memberCount: number;
  copyDefer: boolean;
  copyKind: string;
  copyReason?: string;
  providers: ProviderInboxSplit[];
  worstSenders: Array<{
    email: string;
    bounceRate: number;
    sent: number;
  }>;
  rotated: string[];
  resumed: boolean;
  errors: string[];
}

export interface BounceInvestigateResult {
  dryRun: boolean;
  reportOnly: boolean;
  scannedPaused: number;
  findings: BounceInvestigateFinding[];
  /** Paused campaigns under the investigate threshold (for report mode). */
  underThreshold: Array<{
    campaignId: number;
    campaignName: string;
    aggregateBouncePercent: number;
    sampleSent: number;
  }>;
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

function formatProviderLine(providers: ProviderInboxSplit[]): string {
  if (!providers.length) return "no placement provider split on file";
  return providers
    .map((p) => `${p.name} ${p.inboxPercent.toFixed(0)}% inbox`)
    .join(", ");
}

export class CampaignBounceInvestigateService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; reportOnly?: boolean } = {},
  ): Promise<BounceInvestigateResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const reportOnly = opts.reportOnly ?? false;
    const result: BounceInvestigateResult = {
      dryRun,
      reportOnly,
      scannedPaused: 0,
      findings: [],
      underThreshold: [],
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
      // Our own last-account protective pauses are resumed by health staffing.
      const pending = this.state.getPendingResume(campaign.id);
      if (pending?.reason?.includes("last_account") && !reportOnly) continue;

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

      if (sentTotal < this.config.minBounceSample) {
        if (reportOnly) {
          result.underThreshold.push({
            campaignId: campaign.id,
            campaignName: String(campaign.name ?? campaign.id),
            aggregateBouncePercent:
              sentTotal > 0 ? (bounceWeighted / sentTotal) * 100 : 0,
            sampleSent: sentTotal,
          });
        }
        continue;
      }
      const aggregate = (bounceWeighted / sentTotal) * 100;
      if (aggregate < threshold) {
        result.underThreshold.push({
          campaignId: campaign.id,
          campaignName: String(campaign.name ?? campaign.id),
          aggregateBouncePercent: aggregate,
          sampleSent: sentTotal,
        });
        continue;
      }

      const providers = await providerSplitsForCampaign(
        this.smartDelivery,
        campaign.id,
      );
      const copy = classifyCopySignal(
        providers,
        this.config.remediationInboxThreshold,
      );
      const copyDefer = shouldDeferSenderRotationForCopy(copy);

      badSenders.sort((a, b) => b.rate - a.rate);
      const finding: BounceInvestigateFinding = {
        campaignId: campaign.id,
        campaignName: String(campaign.name ?? campaign.id),
        aggregateBouncePercent: aggregate,
        sampleSent: sentTotal,
        memberCount: members.length,
        copyDefer,
        copyKind: copy.kind,
        copyReason: copy.kind !== "none" ? copy.reason : undefined,
        providers,
        worstSenders: badSenders.slice(0, 10).map((b) => ({
          email: b.email,
          bounceRate: b.rate,
          sent: b.sent,
        })),
        rotated: [],
        resumed: false,
        errors: [],
      };

      if (copyDefer || reportOnly) {
        result.findings.push(finding);
        continue;
      }

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
          finding.rotated.push(
            `${bad.email} (${bad.rate.toFixed(1)}% of ${bad.sent} sent)`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          finding.errors.push(`rotate ${bad.email}: ${message}`);
        }
      }

      try {
        const remaining = await this.smartlead.getCampaignEmailAccounts(
          campaign.id,
        );
        if (remaining.length > 0 && !dryRun) {
          await this.smartlead.updateCampaignStatus(campaign.id, "START");
          finding.resumed = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finding.errors.push(`resume: ${message}`);
      }

      result.findings.push(finding);
    }

    if (result.findings.length && !reportOnly) {
      const lines = this.formatSlack(result.findings, threshold, dryRun);
      try {
        await this.slack.send(lines.join("\n"));
      } catch (error) {
        console.warn("[bounce-investigate] Slack notify failed", error);
      }
    }

    for (const f of result.findings) {
      console.log(
        `[bounce-investigate] #${f.campaignId} ${f.campaignName}: agg=${f.aggregateBouncePercent.toFixed(1)}% sent=${f.sampleSent} copy=${f.copyKind} rotated=${f.rotated.length} resumed=${f.resumed}`,
      );
      if (f.worstSenders.length) {
        console.log(
          `[bounce-investigate]   worst: ${f.worstSenders
            .slice(0, 5)
            .map((s) => `${s.email} ${s.bounceRate.toFixed(1)}%/${s.sent}`)
            .join("; ")}`,
        );
      }
    }

    console.log(
      `[bounce-investigate] paused=${result.scannedPaused} findings=${result.findings.length} reportOnly=${reportOnly}`,
    );
    return result;
  }

  private formatSlack(
    findings: BounceInvestigateFinding[],
    threshold: number,
    dryRun: boolean,
  ): string[] {
    const lines = [
      `${dryRun ? "[DRY RUN] " : ""}Paused-campaign bounce investigation (>${threshold}% aggregate sender bounce):`,
      "",
      "This is *real-lead bounce*, not placement spam-folder. Placement seeds accept mail; bounce means leads rejected the address/domain (or the list is dirty).",
    ];
    for (const f of findings) {
      lines.push("");
      lines.push(
        `*#${f.campaignId} ${f.campaignName}* — ${f.aggregateBouncePercent.toFixed(1)}% bounce across ${f.sampleSent} sends (${f.memberCount} members on campaign)`,
      );
      lines.push(`Placement check (is it the copy?): *${f.copyKind}* — ${f.copyReason ?? "no copy-only pattern"}`);
      lines.push(`Providers: ${formatProviderLine(f.providers)}`);
      if (f.copyDefer) {
        lines.push(
          "Action: *not rotating senders* — looks like campaign copy/offer. Test/fix the sequence.",
        );
      } else {
        lines.push(
          `Action: rotated ${f.rotated.length} worst bouncing sender(s)${f.resumed ? ", resumed campaign" : ", left paused (no senders left or resume failed)"}.`,
        );
        for (const s of f.worstSenders.slice(0, 8)) {
          const did = f.rotated.some((r) => r.startsWith(s.email));
          lines.push(
            `• \`${s.email}\` — ${s.bounceRate.toFixed(1)}% bounce of ${s.sent} sent${did ? " → pulled + warmup on" : ""}`,
          );
        }
      }
      if (f.errors.length) {
        lines.push(`Errors: ${f.errors.slice(0, 3).join("; ")}`);
      }
    }
    return lines;
  }
}
