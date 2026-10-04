/**
 * D230 / D232 — morning named-warm swap + surplus return.
 *
 * A generic leaves its POD when that POD's warm named staffable
 * *weight* (without generics) fills the 40, one generic per named
 * seat that goes warm. Surplus beyond 40 also returns. Oldest /
 * worst generic first. Never drop named + remaining generics
 * below 40. Azure seats weigh 0.1 (D232).
 */

import { STAFFABLE_WEIGHT_EPS } from "./mailboxType.js";
import {
  GENERIC_POOL_POD_FLOOR,
  seatStaffableWeight,
  type GenericSeatRecord,
} from "./genericPool.js";
import { rankGenericsOldestWorstFirst } from "./genericAssign.js";

export function namedWarmSwapReturnCount(input: {
  namedStaffable: number;
  assignedCount: number;
  previousNamedStaffable?: number;
  clientHasActiveCampaign?: boolean;
  floor?: number;
  assignedWeights?: number[];
}): number {
  const weights =
    input.assignedWeights ??
    Array.from({ length: Math.max(0, Math.floor(input.assignedCount || 0)) }, () => 1);
  if (input.clientHasActiveCampaign === false) return weights.length;
  const picked = pickWeightedGenericReturns(
    weights.map((staffableWeight, i) => ({
      email: `seat-${i}`,
      assignedAt: null,
      staffableWeight,
    })),
    {
      namedStaffable: input.namedStaffable,
      previousNamedStaffable: input.previousNamedStaffable,
      floor: input.floor,
    },
  );
  return picked.length;
}

export function pickNamedWarmSwapReturns<T extends Pick<GenericSeatRecord, "email" | "assignedAt">>(
  seats: T[],
  count: number,
): T[] {
  if (count <= 0) return [];
  return rankGenericsOldestWorstFirst(seats).slice(0, count);
}

/** Oldest / worst first, never dropping named + remaining below the weighted 40. */
export function pickWeightedGenericReturns<
  T extends Pick<GenericSeatRecord, "email" | "assignedAt"> & {
    staffableWeight?: number;
  },
>(
  seats: T[],
  input: {
    namedStaffable: number;
    previousNamedStaffable?: number;
    floor?: number;
  },
): T[] {
  const floor = input.floor ?? GENERIC_POOL_POD_FLOOR;
  const named = Number.isFinite(input.namedStaffable)
    ? Math.max(0, input.namedStaffable)
    : 0;
  const ranked = rankGenericsOldestWorstFirst(seats);
  const assignedWeight = ranked.reduce((sum, seat) => sum + seatStaffableWeight(seat), 0);
  const previous = input.previousNamedStaffable;
  const newlyWarm =
    previous == null ? 0 : Math.max(0, named - Math.max(0, previous));
  const overFloor = Math.max(0, named + assignedWeight - floor);
  // One per newly-warm named seat, and any extras past 40. The
  // floor wins: never return more than overFloor (D230/D232).
  let surplus = Math.min(assignedWeight, Math.max(overFloor, newlyWarm), overFloor);
  const out: T[] = [];
  for (const seat of ranked) {
    const weight = seatStaffableWeight(seat);
    if (weight > surplus + STAFFABLE_WEIGHT_EPS) continue;
    out.push(seat);
    surplus -= weight;
    if (surplus <= STAFFABLE_WEIGHT_EPS) break;
  }
  return out;
}
