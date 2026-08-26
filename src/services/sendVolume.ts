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

/**
 * Split a `CRON_SEND_VOLUME` value into individual cron expressions.
 *
 * Pipe-separated rather than comma-separated because cron already uses commas
 * inside a field ("0 9 * * 1,4"), so a comma split would silently cut valid
 * expressions in half.
 */
export function parseSchedules(value: string): string[] {
  return value
    .split("|")
    .map((expression) => expression.trim())
    .filter(Boolean);
}
