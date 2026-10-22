/**
 * D299 — one-time Generics Ledger pins for three free-pool generics an
 * operator attached to a client POD on 2026-10-22. Each pinned row covers
 * that POD's still-warming named seats (warm-ready 2026-11-05). Applied after
 * the normal covering_for link on every sync, so it is idempotent: the same
 * inputs always give the same rows. A pin lapses on its own once the seat is
 * no longer assigned to that client/POD or the named seats finish warming.
 */
import type { GenericSeatRecord } from "./genericPool.js";
import type { WarmingBrandedSeat } from "./genericLedger.js";

export interface LedgerPin {
  email: string;
  clientId: number;
  pod: "A" | "B";
  warmReadyAt: string;
  assignedAt: string;
  reason: string;
}

const PIN_CLIENT = 574020;
const PIN_READY = "2026-11-05T00:00:00.000Z";
const PIN_AT = "2026-10-22T16:00:00.000Z";
export const LEDGER_PINS: readonly LedgerPin[] = [
  "arjunnovak@outreachdesknow.com",
  "ishadiallo@outreachdesknow.com",
  "kwamebrooks@meetconnecthub.com",
].map((email) => ({
  email,
  clientId: PIN_CLIENT,
  pod: "B" as const,
  warmReadyAt: PIN_READY,
  assignedAt: PIN_AT,
  reason: "pod_top_up",
}));

export function applyLedgerPins(
  seats: GenericSeatRecord[],
  warming: readonly WarmingBrandedSeat[],
  pins: readonly LedgerPin[] = LEDGER_PINS,
): number {
  let applied = 0;
  const byEmail = new Map(seats.map((s) => [s.email.toLowerCase(), s]));
  const groups = new Map<string, LedgerPin[]>();
  for (const pin of pins) {
    const seat = byEmail.get(pin.email.toLowerCase());
    if (!seat || seat.assignedClientId !== pin.clientId || seat.assignedPod !== pin.pod) continue;
    const key = `${pin.clientId}:${pin.pod}`;
    groups.set(key, [...(groups.get(key) ?? []), pin]);
  }
  for (const [key, group] of groups) {
    const targets = warming
      .filter((w) => `${w.clientId}:${w.pod}` === key)
      .map((w) => w.email.toLowerCase())
      .sort();
    if (!targets.length) continue;
    const targetSet = new Set(targets);
    // A warming seat is covered by exactly one generic: take it off others.
    for (const seat of seats) {
      seat.coveringFor = seat.coveringFor.filter((c) => !targetSet.has(c.email.toLowerCase()));
    }
    group.forEach((pin, i) => {
      const seat = byEmail.get(pin.email.toLowerCase())!;
      seat.coveringFor = targets
        .filter((_, j) => j % group.length === i)
        .map((email) => ({ email, warmReadyAt: pin.warmReadyAt }));
      seat.reason = seat.reason ?? pin.reason;
      seat.assignedAt = seat.assignedAt ?? pin.assignedAt;
      applied += 1;
    });
  }
  return applied;
}
