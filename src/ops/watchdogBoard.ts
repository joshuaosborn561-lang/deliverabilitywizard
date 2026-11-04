/**
 * Per-client sends today and leads left from the campaign-watchdog reading.
 * The hourly job stores that snapshot. This board does not sum
 * `daily_sent_count` and does not read lead-runout.
 */

import {
  WATCHDOG_DAILY_TARGET,
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
  sendsToday: number;
  leadsLeft: number | null;
}

export interface WatchdogSnapshot {
  updatedAt: string;
  partial: boolean;
  day: string;
  paceTarget: number;
  source: "campaign-watchdog-analytics";
  clients: WatchdogSnapshotClient[];
}

export interface WatchdogClient {
  clientId: string;
  clientName: string;
  sendsToday: number | null;
  target: number;
  leadsLeft: number | null;
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

function statusFor(
  sends: number | null,
  target: number,
  leads: number | null,
): WatchdogStatus {
  if (leads != null && leads < OPS_BRING_TO_JOSH_LEADS) return "josh";
  if (leads != null && leads < OPS_TOP_UP_LEADS) return "topup";
  if (sends == null || target <= 0) return "unread";
  if (sends < target) return "behind";
  return "healthy";
}

export function buildWatchdogBoard(input: {
  snapshot?: WatchdogSnapshot | null;
}): WatchdogBoard {
  const snapshot = input.snapshot ?? null;
  const target = snapshot?.paceTarget || WATCHDOG_DAILY_TARGET;
  const clients: WatchdogClient[] = (snapshot?.clients ?? [])
    .filter((row) => row.clientName.trim().length > 0)
    .map((row) => ({
      clientId: row.clientId,
      clientName: row.clientName,
      sendsToday: Number.isFinite(row.sendsToday) ? Math.max(0, row.sendsToday) : null,
      target,
      leadsLeft:
        row.leadsLeft == null || !Number.isFinite(row.leadsLeft)
          ? null
          : Math.max(0, row.leadsLeft),
      status: statusFor(
        Number.isFinite(row.sendsToday) ? row.sendsToday : null,
        target,
        row.leadsLeft == null || !Number.isFinite(row.leadsLeft) ? null : row.leadsLeft,
      ),
    }))
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
    partial: Boolean(snapshot?.partial),
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
