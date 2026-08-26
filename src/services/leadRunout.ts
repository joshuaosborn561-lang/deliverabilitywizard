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
import type { StateStore } from "../state/store.js";

export interface LeadRunoutResult {
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
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
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

    const active = campaigns.filter(
      (campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE",
    );
    const end = ymdUtc(new Date());
    const start = addUtcDays(end, -2);

    for (const campaign of active) {
      result.scanned += 1;
      try {
        const [statsRaw, recent] = await Promise.all([
          this.smartlead.getCampaignStatistics(campaign.id).catch(() => null),
          this.smartlead
            .getCampaignAnalyticsByDate(campaign.id, start, end)
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
