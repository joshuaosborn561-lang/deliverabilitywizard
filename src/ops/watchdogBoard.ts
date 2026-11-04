/**
 * Per-client sends today against the current canon pace.
 * Pace is the sum of type-aware mailbox caps unless CANON sets
 * `CLIENT_DAILY_SEND_PACE`. Leads left come from the lead-runout
 * snapshot (counts only). No Smartlead fetch.
 */

import type { SmartleadClientRecord } from "../clients/smartlead.js";
import { clientDisplayName } from "../clients/smartlead.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import {
  mailboxMessagePerDayTarget,
  type SendCeilingAccount,
} from "../lib/sendCeiling.js";
import type { LeadRunwayRecord } from "../state/store.js";
import {
  CLIENT_DAILY_SEND_PACE,
  OPS_BRING_TO_JOSH_LEADS,
  OPS_TOP_UP_LEADS,
} from "./canonSurface.js";

export type WatchdogStatus =
  | "healthy"
  | "behind"
  | "topup"
  | "josh"
  | "unread";

export interface WatchdogAccount {
  client_id?: number | null;
  daily_sent_count?: number;
  message_per_day?: number;
  type?: string | null;
  from_email?: string | null;
  email?: string | null;
  campaigns?: Array<{ status?: string | null }>;
}

export interface WatchdogClient {
  clientId: string;
  clientName: string;
  sendsToday: number | null;
  target: number;
  leadsLeft: number | null;
  status: WatchdogStatus;
}

export interface WatchdogBoard {
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

function named(client: SmartleadClientRecord): string {
  return brandFromClientDisplayName(clientDisplayName(client));
}

function onActiveCampaign(account: WatchdogAccount): boolean {
  const campaigns = account.campaigns ?? [];
  if (!campaigns.length) return true;
  return campaigns.some(
    (campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE",
  );
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
  accounts?: WatchdogAccount[];
  clients?: SmartleadClientRecord[];
  runway?: LeadRunwayRecord[];
  messagePerDay: number;
}): WatchdogBoard {
  const fixed = CLIENT_DAILY_SEND_PACE;
  const paceLabel =
    fixed == null ? "mailbox caps" : `${fixed.toLocaleString("en-US")}/day`;
  const byClient = new Map<
    string,
    { name: string; sends: number; sawSent: boolean; target: number; leads: number | null }
  >();

  const ensure = (id: string, name: string) => {
    const existing = byClient.get(id);
    if (existing) {
      if (!existing.name && name) existing.name = name;
      return existing;
    }
    const created = {
      name,
      sends: 0,
      sawSent: false,
      target: fixed ?? 0,
      leads: null as number | null,
    };
    byClient.set(id, created);
    return created;
  };

  for (const client of input.clients ?? []) {
    const name = named(client);
    if (!name) continue;
    ensure(String(client.id), name);
  }

  for (const account of input.accounts ?? []) {
    const clientId = account.client_id;
    if (typeof clientId !== "number" || clientId <= 0) continue;
    if (!onActiveCampaign(account)) continue;
    const row = ensure(String(clientId), "");
    if (typeof account.daily_sent_count === "number" && Number.isFinite(account.daily_sent_count)) {
      row.sends += Math.max(0, account.daily_sent_count);
      row.sawSent = true;
    }
    if (fixed == null) {
      row.target += mailboxMessagePerDayTarget(
        account as SendCeilingAccount,
        { messagePerDay: input.messagePerDay },
      );
    }
  }

  for (const runway of input.runway ?? []) {
    if (typeof runway.clientId !== "number" || runway.clientId <= 0) continue;
    if (!Number.isFinite(runway.remaining)) continue;
    const row = ensure(String(runway.clientId), "");
    row.leads = (row.leads ?? 0) + Math.max(0, runway.remaining);
  }

  const clients: WatchdogClient[] = [];
  for (const [clientId, row] of byClient) {
    if (!row.name) continue;
    const hasSignal = row.sawSent || row.leads != null || row.target > 0;
    if (!hasSignal) continue;
    const sendsToday = row.sawSent ? row.sends : null;
    clients.push({
      clientId,
      clientName: row.name,
      sendsToday,
      target: row.target,
      leadsLeft: row.leads,
      status: statusFor(sendsToday, row.target, row.leads),
    });
  }
  clients.sort((a, b) => a.clientName.localeCompare(b.clientName));

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
    paceLabel,
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
