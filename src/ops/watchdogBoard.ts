/**
 * Per-client sends today and leads left from the campaign-watchdog reading.
 * The hourly job stores that snapshot. This board does not sum
 * `daily_sent_count` and does not read lead-runout.
 */

import {
  WATCHDOG_DAILY_TARGET,
  ymdInZone,
} from "./campaignWatchdogVolume.js";
import {
  OPS_BRING_TO_JOSH_LEADS,
  OPS_TOP_UP_LEADS,
} from "./canonSurface.js";

export type WatchdogStatus =
  | "healthy"
  | "behind"
  | "topup"
  | "josh"
  | "unread";

export interface WatchdogSnapshotClient {
  clientId: string;
  clientName: string;
  /** Sum over the client's campaigns that have a reading for `day`. */
  sendsToday: number;
  /** Sum over campaigns with a lead reading; null when none was read. */
  leadsLeft: number | null;
  /** ACTIVE client campaigns in the pass. Absent on pre-fix snapshots. */
  campaigns?: number;
  /** Campaigns counted in `sendsToday` / `leadsLeft`. */
  sendsRead?: number;
  leadsRead?: number;
}

/** One campaign's reading, kept so a short pass can carry it over. */
export interface WatchdogCampaignReading {
  id: number;
  clientId: string;
  /** Eastern send day the `sendsToday` value belongs to. */
  day: string;
  sendsToday: number | null;
  leadsLeft: number | null;
  readAt: string;
}

export interface WatchdogSnapshot {
  updatedAt: string;
  partial: boolean;
  day: string;
  paceTarget: number;
  source: "campaign-watchdog-analytics";
  clients: WatchdogSnapshotClient[];
  campaigns?: WatchdogCampaignReading[];
}

export interface WatchdogClient {
  clientId: string;
  clientName: string;
  sendsToday: number | null;
  target: number;
  leadsLeft: number | null;
  /** ACTIVE campaigns, and how many are counted in each number. */
  campaigns: number | null;
  sendsRead: number | null;
  leadsRead: number | null;
  status: WatchdogStatus;
}

/** Inventory shape the hourly job does not read. Kept so the peek type stays stable. */
export interface WatchdogAccount {
  client_id?: number | null;
  daily_sent_count?: number;
  message_per_day?: number;
  type?: string | null;
  from_email?: string | null;
  email?: string | null;
  campaigns?: Array<{ status?: string | null }>;
}

export interface WatchdogBoard {
  updatedAt: string | null;
  partial: boolean;
  day: string | null;
  source: string;
  paceLabel: string;
  sendsToday: number;
  onPace: number;
  tracked: number;
  needTopUp: number;
  bringToJosh: number;
  topUpBelow: number;
  joshBelow: number;
  clients: WatchdogClient[];
}

/**
 * A sum over only some of a client's campaigns is a floor, not a reading:
 * leads under a threshold with campaigns unread is "unread", not top-up;
 * leads over it already clear the threshold. Same for sends vs pace.
 */
function statusFor(
  sends: number | null,
  sendsComplete: boolean,
  target: number,
  leads: number | null,
  leadsComplete: boolean,
): WatchdogStatus {
  if (leads == null) return "unread";
  if (leads < OPS_TOP_UP_LEADS && !leadsComplete) return "unread";
  if (leads < OPS_BRING_TO_JOSH_LEADS) return "josh";
  if (leads < OPS_TOP_UP_LEADS) return "topup";
  if (sends == null || target <= 0) return "unread";
  if (sends >= target) return "healthy";
  return sendsComplete ? "behind" : "unread";
}

function finite(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.max(0, value);
}

export function buildWatchdogBoard(input: {
  snapshot?: WatchdogSnapshot | null;
  now?: Date;
}): WatchdogBoard {
  const snapshot = input.snapshot ?? null;
  const target = snapshot?.paceTarget || WATCHDOG_DAILY_TARGET;
  // A snapshot from an earlier send day has no sends for today.
  const today = ymdInZone(input.now ?? new Date());
  const sameDay = !snapshot?.day || snapshot.day === today;
  const clients: WatchdogClient[] = (snapshot?.clients ?? [])
    .filter((row) => row.clientName.trim().length > 0)
    .map((row) => {
      const campaigns = finite(row.campaigns);
      const sendsRead = finite(row.sendsRead);
      const leadsRead = finite(row.leadsRead);
      const sendsToday = sameDay ? finite(row.sendsToday) : null;
      const leadsLeft = finite(row.leadsLeft);
      // Pre-fix snapshots carry no counts; treat them as complete.
      const sendsComplete = campaigns == null || sendsRead == null || sendsRead >= campaigns;
      const leadsComplete = campaigns == null || leadsRead == null || leadsRead >= campaigns;
      return {
        clientId: row.clientId,
        clientName: row.clientName,
        sendsToday: sendsToday != null && sendsRead === 0 ? null : sendsToday,
        target,
        leadsLeft,
        campaigns,
        sendsRead,
        leadsRead,
        status: statusFor(
          sendsToday != null && sendsRead === 0 ? null : sendsToday,
          sendsComplete,
          target,
          leadsLeft,
          leadsComplete,
        ),
      };
    })
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

  let sendsToday = 0;
  let onPace = 0;
  let tracked = 0;
  let needTopUp = 0;
  let bringToJosh = 0;
  for (const client of clients) {
    if (client.sendsToday != null) sendsToday += client.sendsToday;
    if (client.target > 0 && client.sendsToday != null) {
      tracked += 1;
      if (client.sendsToday >= client.target) onPace += 1;
    }
    if (client.status === "topup") needTopUp += 1;
    if (client.status === "josh") bringToJosh += 1;
  }

  return {
    updatedAt: snapshot?.updatedAt ?? null,
    partial:
      Boolean(snapshot?.partial) ||
      !sameDay ||
      clients.some(
        (client) =>
          client.campaigns != null &&
          ((client.sendsRead ?? 0) < client.campaigns || (client.leadsRead ?? 0) < client.campaigns),
      ),
    day: snapshot?.day ?? null,
    source: snapshot?.source ?? "campaign-watchdog-analytics",
    paceLabel: `${target.toLocaleString("en-US")}/day`,
    sendsToday,
    onPace,
    tracked,
    needTopUp,
    bringToJosh,
    topUpBelow: OPS_TOP_UP_LEADS,
    joshBelow: OPS_BRING_TO_JOSH_LEADS,
    clients,
  };
}
