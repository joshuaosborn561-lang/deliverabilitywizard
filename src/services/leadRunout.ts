import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import {
  addUtcDays,
  statsFromAnalytics,
  ymdUtc,
} from "../lib/campaignDayStats.js";
import {
  classifyRunoutPerformance,
  consumedPercent,
  formatRunoutMessage,
  parseCampaignLeadStats,
  runoutStage,
  type RunoutStage,
} from "../lib/leadRunout.js";
import {
  callerFollowUpPolicyFromConfig,
  callerFollowUpSkipsRunwayAndTopUpAlerts,
} from "../lib/callerFollowUp.js";
import type { StateStore } from "../state/store.js";

/**
 * D320 — lead-runout walks every ACTIVE campaign (2-3 Smartlead reads each,
 * normal lane). It timed out at 10m five times running while those reads
 * 429'd (4 retries each). Now: one retry per read, a 7-minute budget, and the
 * walk resumes where the last pass stopped.
 */
export const LEAD_RUNOUT_BUDGET_MS = 7 * 60 * 1000;
export const LEAD_RUNOUT_READ_RETRIES = 1;

export interface LeadRunoutResult {
  /** D320 — campaigns left for the next pass. */
  carriedOver?: number;
  scanned: number;
  flagged: Array<{ campaignId: number; name: string; stage: RunoutStage }>;
  skipped: string[];
  errors: string[];
}

/**
 * D52 — tell Josh when a working campaign is running out of leads.
 * Does not import leads or extend a campaign.
 */
export class LeadRunoutService {
  /** D320 — where the next pass resumes (in memory; a restart starts at the top). */
  private carryCursor = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    /** Test seam — defaults to LEAD_RUNOUT_BUDGET_MS. */
    private readonly budgetMs: number = LEAD_RUNOUT_BUDGET_MS,
  ) {}

  async run(): Promise<LeadRunoutResult> {
    const result: LeadRunoutResult = {
      scanned: 0,
      flagged: [],
      skipped: [],
      errors: [],
    };
    if (!this.config.enableLeadRunout) {
      console.log("[lead-runout] Disabled");
      return result;
    }

    let campaigns;
    try {
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list campaigns: ${message}`);
      return result;
    }

    const activeAll = campaigns.filter(
      (campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE",
    );
    const at = activeAll.length ? this.carryCursor % activeAll.length : 0;
    const active = [...activeAll.slice(at), ...activeAll.slice(0, at)];
    const deadline = Date.now() + this.budgetMs;
    let walked = 0;
    const end = ymdUtc(new Date());
    const start = addUtcDays(end, -2);

    for (const campaign of active) {
      if (Date.now() >= deadline) break;
      walked += 1;
      if (
        callerFollowUpSkipsRunwayAndTopUpAlerts(
          campaign,
          callerFollowUpPolicyFromConfig(this.config),
        )
      ) {
        result.skipped.push(`#${campaign.id}: CALLER FOLLOW-UP (D242)`);
        continue;
      }
      result.scanned += 1;
      try {
        const [statsRaw, recent] = await Promise.all([
          this.smartlead
            .getCampaignStatistics(campaign.id, {}, { retries: LEAD_RUNOUT_READ_RETRIES })
            .catch(() => null),
          this.smartlead
            .getCampaignAnalyticsByDate(campaign.id, start, end, {
              retries: LEAD_RUNOUT_READ_RETRIES,
            })
            .catch(() => null),
        ]);
        await sleep(150);

        let stats = parseCampaignLeadStats(statsRaw);
        if (!stats) {
          const campaignRow = await this.smartlead.getCampaign(campaign.id).catch(() => null);
          stats = parseCampaignLeadStats(campaignRow);
        }
        if (!stats) {
          result.skipped.push(`#${campaign.id}: no lead totals`);
          continue;
        }

        const stage = runoutStage(consumedPercent(stats));
        if (!stage) continue;

        const key = `lead-runout:v1:${campaign.id}:${stage}:${stats.total}`;
        if (this.state.hasAlert(key)) continue;

        const sent = statsFromAnalytics(recent).sent;
        const sentPerDay = sent / 3;
        const performance = classifyRunoutPerformance(
          stats,
          this.config.minBounceSample,
        );
        const text = formatRunoutMessage({
          campaignName: campaign.name,
          stage,
          remaining: stats.remaining,
          sentPerDay,
          performance,
        });
        await this.slack.notifyLeadRunout({ text });
        this.state.markAlert(key);
        result.flagged.push({
          campaignId: campaign.id,
          name: campaign.name,
          stage,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id}: ${message}`);
      }
    }

    result.carriedOver = activeAll.length - walked;
    if (result.carriedOver > 0) {
      this.carryCursor = (at + walked) % activeAll.length;
      console.log(
        `[lead-runout] D320 budget spent — ${result.carriedOver} of ${activeAll.length} active campaign(s) carry to the next pass`,
      );
    } else {
      this.carryCursor = 0;
    }

    if (result.flagged.length) {
      console.log(
        `[lead-runout] flagged ${result.flagged.length}:`,
        result.flagged.map((row) => `${row.name} ${row.stage}`).join(", "),
      );
    }
    await this.state.save();
    return result;
  }
}
