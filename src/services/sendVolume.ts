import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";

/**
 * Fleet send volume: how much mail went out today, across how many campaigns.
 *
 * The staffing and placement services answer "is each campaign healthy?".
 * Neither answers "are we actually sending?" — a fleet can pass every health
 * check while volume quietly collapses because lead lists ran dry. This is the
 * top-line number for that.
 *
 * Smartlead exposes no account-wide total, so this is one analytics call per
 * ACTIVE campaign, paced under the documented 10-req/2s limit.
 */

export interface CampaignVolumeRow {
  id: number;
  name: string;
  sent: number;
}

export interface SendVolumeResult {
  /** Business date the counts cover (America/New_York). */
  date: string;
  activeCampaigns: number;
  /** ACTIVE campaigns that sent at least one email today. */
  sendingCampaigns: number;
  totalSent: number;
  rows: CampaignVolumeRow[];
  /** ACTIVE campaigns whose analytics call failed — excluded from totalSent. */
  errors: string[];
}

/** Smartlead reports counts as numbers or numeric strings depending on route. */
function toCount(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Today in America/New_York. The monitor cron runs on the container clock
 * (UTC on Railway), so using the raw date would roll the "day" over at 8pm
 * local and split an evening's sending across two reports.
 */
export function businessDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export class SendVolumeService {
  constructor(
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
  ) {}

  async run(options: { alert?: boolean } = {}): Promise<SendVolumeResult> {
    const date = businessDate();
    const campaigns = await this.smartlead.listCampaigns();
    const active = campaigns.filter(
      (c) => String(c.status ?? "").toUpperCase() === "ACTIVE",
    );

    const rows: CampaignVolumeRow[] = [];
    const errors: string[] = [];
    for (const campaign of active) {
      try {
        const analytics = await this.smartlead.getCampaignAnalyticsByDate(
          campaign.id,
          date,
          date,
        );
        rows.push({
          id: campaign.id,
          name: String(campaign.name ?? `campaign ${campaign.id}`),
          sent: toCount(analytics?.sent_count),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`#${campaign.id} ${campaign.name ?? ""}: ${message}`);
      }
      // Smartlead allows 10 requests / 2s; stay well under it so a wide fleet
      // cannot starve the mutation queue the rest of the monitor pass needs.
      await sleep(250);
    }

    rows.sort((a, b) => b.sent - a.sent);
    const result: SendVolumeResult = {
      date,
      activeCampaigns: active.length,
      sendingCampaigns: rows.filter((r) => r.sent > 0).length,
      totalSent: rows.reduce((sum, r) => sum + r.sent, 0),
      rows,
      errors,
    };

    console.log(
      `[send-volume] ${date}: ${result.totalSent} sent across ${result.sendingCampaigns}/${result.activeCampaigns} active campaign(s)${errors.length ? `; ${errors.length} lookup error(s)` : ""}`,
    );
    for (const row of rows) {
      console.log(`[send-volume]   #${row.id} ${row.name} — ${row.sent}`);
    }
    for (const error of errors) {
      console.warn(`[send-volume]   lookup failed ${error}`);
    }

    if (options.alert !== false) {
      await this.slack.notifySendVolume(result);
    }
    return result;
  }
}
