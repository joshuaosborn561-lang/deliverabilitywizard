/**
 * D225 / D230 — morning named-warm swap + surplus return.
 * One generic per named seat that goes warm, oldest / worst first,
 * plus any extras past 40. Returns to the untagged pool.
 * PowerGRYD 592842 and an active 24h TERRL substitute stay.
 * Never drop a POD below 40 staffable. Weekdays only.
 */

import { isChicagoWeekday } from "./canonOpsHours.js";
import { rankGenericsOldestWorstFirst } from "./genericAssign.js";
import {
  GENERIC_POOL_POD_FLOOR,
  GENERIC_POOL_POWERGRYD_CLIENT_ID,
  clientPodKey,
  genericPoolIdleExempt,
  genericSeatKey,
  type GenericAssignedPod,
  type GenericSeatRecord,
} from "./genericPool.js";
import { pickWeightedGenericReturns } from "./namedWarmSwap.js";

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
  void input.campaignClientById;
  void input.liveClientIdsByEmail;
  const grouped = new Map<string, GenericSeatRecord[]>();
  const unpodded: SurplusReturnCandidate[] = [];
  for (const seat of input.seats) {
    if (seat.assignedClientId == null) continue;
    if (genericPoolIdleExempt(seat, powerId)) continue;
    if (skip.has(genericSeatKey(seat.email))) continue;
    if (!seat.assignedPod) {
      unpodded.push({
        email: seat.email,
        clientId: seat.assignedClientId,
        pod: null,
      });
      continue;
    }
    const key = clientPodKey(seat.assignedClientId, seat.assignedPod);
    const list = grouped.get(key) ?? [];
    list.push(seat);
    grouped.set(key, list);
  }
  const out: SurplusReturnCandidate[] = [...unpodded];
  for (const [key, seats] of grouped) {
    const [clientRaw, podRaw] = key.split(":");
    const clientId = Number(clientRaw);
    const pod = podRaw as GenericAssignedPod;
    const named = input.namedStaffableByClientPod.get(key) ?? 0;
    const picked =
      input.clientHasActiveCampaign?.get(clientId) === false
        ? rankGenericsOldestWorstFirst(seats)
        : pickWeightedGenericReturns(seats, { namedStaffable: named });
    for (const seat of picked) {
      out.push({
        email: seat.email,
        clientId: seat.assignedClientId!,
        pod,
      });
    }
  }
  return rankGenericsOldestWorstFirst(
    out.map((row) => ({
      ...row,
      assignedAt:
        input.seats.find((seat) => genericSeatKey(seat.email) === genericSeatKey(row.email))
          ?.assignedAt ?? null,
    })),
  ).map(({ email, clientId, pod }) => ({ email, clientId, pod }));
}

/** True when keeping this generic is required to hold the POD at 40. */
export function returningWouldDropPodBelow40(
  namedStaffable: number,
  assignedKept: number,
): boolean {
  return namedStaffable + assignedKept < GENERIC_POOL_POD_FLOOR;
}
