/**
 * D225 — surplus pool generics return to the fleet table.
 * A generic that is not needed for its POD's 40 is unlinked,
 * client_id cleared, signature reset. PowerGRYD 592842 and an
 * active 24h TERRL substitute stay. Never drop a POD below 40
 * staffable. Weekdays only.
 */

import { isChicagoWeekday } from "./canonOpsHours.js";
import {
  GENERIC_POOL_POD_FLOOR,
  GENERIC_POOL_POWERGRYD_CLIENT_ID,
  genericPoolIdleExempt,
  genericSeatKey,
  type GenericSeatRecord,
} from "./genericPool.js";
import { validateGenericPool } from "./genericPoolCanon.js";

export const GENERIC_SURPLUS_RETURN_WEEKDAYS_ONLY = true;

export interface SurplusReturnCandidate {
  email: string;
  clientId: number;
  pod: string | null;
}

export function openTerlSubstituteEmails(
  rows: Iterable<{
    substituteEmail?: string | null;
    restoredAt?: string | null;
    restoreAfter?: string | null;
  }>,
  now = new Date(),
): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    const email = String(row.substituteEmail ?? "")
      .trim()
      .toLowerCase();
    if (!email.includes("@")) continue;
    if (row.restoredAt) continue;
    const until = row.restoreAfter ? Date.parse(row.restoreAfter) : NaN;
    if (Number.isFinite(until) && now.getTime() >= until) continue;
    out.add(email);
  }
  return out;
}

export function surplusGenericReturns(input: {
  seats: GenericSeatRecord[];
  namedStaffableByClientPod: ReadonlyMap<string, number>;
  clientHasActiveCampaign?: ReadonlyMap<number, boolean>;
  campaignClientById?: ReadonlyMap<number, number | null>;
  liveClientIdsByEmail?: ReadonlyMap<string, readonly number[]>;
  powerGrydClientId?: number;
  skipEmails?: Iterable<string>;
  now?: Date;
  weekdaysOnly?: boolean;
}): SurplusReturnCandidate[] {
  const now = input.now ?? new Date();
  const weekdaysOnly = input.weekdaysOnly ?? GENERIC_SURPLUS_RETURN_WEEKDAYS_ONLY;
  if (weekdaysOnly && !isChicagoWeekday(now)) return [];

  const powerId = input.powerGrydClientId ?? GENERIC_POOL_POWERGRYD_CLIENT_ID;
  const skip = new Set(
    [...(input.skipEmails ?? [])].map((email) => genericSeatKey(email)),
  );
  const idle = validateGenericPool({
    seats: input.seats,
    namedStaffableByClientPod: input.namedStaffableByClientPod,
    clientHasActiveCampaign: input.clientHasActiveCampaign,
    campaignClientById: input.campaignClientById,
    liveClientIdsByEmail: input.liveClientIdsByEmail,
    powerGrydClientId: powerId,
    idleExemptEmails: skip,
  }).filter((row) => row.kind === "generic_idle");

  const byEmail = new Map(
    input.seats.map((seat) => [genericSeatKey(seat.email), seat]),
  );
  const out: SurplusReturnCandidate[] = [];
  for (const finding of idle) {
    const seat = byEmail.get(genericSeatKey(finding.email));
    if (!seat || seat.assignedClientId == null) continue;
    if (genericPoolIdleExempt(seat, powerId)) continue;
    if (skip.has(seat.email)) continue;
    out.push({
      email: seat.email,
      clientId: seat.assignedClientId,
      pod: seat.assignedPod,
    });
  }
  return out;
}

/** True when keeping this generic is required to hold the POD at 40. */
export function returningWouldDropPodBelow40(
  namedStaffable: number,
  assignedKept: number,
): boolean {
  return namedStaffable + assignedKept < GENERIC_POOL_POD_FLOOR;
}
