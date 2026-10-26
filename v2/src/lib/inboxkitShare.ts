/**
 * D303 — v2 port of the old wizard's InboxKit ESP split (D301). Data-driven:
 * a client's Microsoft share is counted from the client's own live InboxKit
 * mailboxes, joined to Smartlead accounts by email (account.clientId). No
 * client names are mapped in code.
 */

import { isLapsedSeat, chicagoYmd, type InboxkitMailbox } from "../clients/inboxkit.js";
import type { SlimAccount } from "../types.js";

export function inboxkitPlatformFamily(platform: string | null | undefined): "google" | "microsoft" | "other" {
  const p = String(platform ?? "").trim().toUpperCase();
  if (!p) return "other";
  if (p.includes("GOOGLE") || p.includes("GMAIL") || p.includes("GSUITE")) return "google";
  if (p.includes("MICROSOFT") || p.includes("OUTLOOK") || p.includes("O365") || p.includes("M365") || p.includes("AZURE")) {
    return "microsoft";
  }
  return "other";
}

/** clientId → InboxKit Microsoft share (0..1). Clients with no InboxKit rows are absent. */
export function clientMicrosoftShares(
  seats: InboxkitMailbox[],
  accounts: SlimAccount[],
  now = new Date(),
): Map<number, number> {
  const today = chicagoYmd(now);
  const clientOf = new Map(accounts.map((a) => [a.email.toLowerCase(), a.clientId]));
  const tally = new Map<number, { g: number; m: number }>();
  for (const seat of seats) {
    if (!seat.email || isLapsedSeat(seat, today)) continue;
    const clientId = clientOf.get(seat.email.toLowerCase());
    if (clientId == null) continue;
    const family = inboxkitPlatformFamily(seat.platform);
    if (family === "other") continue;
    const t = tally.get(clientId) ?? { g: 0, m: 0 };
    if (family === "google") t.g += 1;
    else t.m += 1;
    tally.set(clientId, t);
  }
  const out = new Map<number, number>();
  for (const [clientId, t] of tally) {
    if (t.g + t.m > 0) out.set(clientId, t.m / (t.g + t.m));
  }
  return out;
}
