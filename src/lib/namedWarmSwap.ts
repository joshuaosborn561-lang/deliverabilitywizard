/**
 * D230 — morning named-warm swap + surplus return.
 *
 * A generic leaves its POD when that POD's warm named staffable
 * count (without generics) fills the 40, one generic per named
 * seat that goes warm. Surplus beyond 40 also returns. Oldest /
 * worst generic first. Never drop named + remaining generics
 * below 40.
 */

import { GENERIC_POOL_POD_FLOOR, type GenericSeatRecord } from "./genericPool.js";
import { rankGenericsOldestWorstFirst } from "./genericAssign.js";

export function namedWarmSwapReturnCount(input: {
  namedStaffable: number;
  assignedCount: number;
  previousNamedStaffable?: number;
  clientHasActiveCampaign?: boolean;
  floor?: number;
}): number {
  const assigned = Number.isFinite(input.assignedCount)
    ? Math.max(0, Math.floor(input.assignedCount))
    : 0;
  if (input.clientHasActiveCampaign === false) return assigned;
  const floor = input.floor ?? GENERIC_POOL_POD_FLOOR;
  const named = Number.isFinite(input.namedStaffable)
    ? Math.max(0, Math.floor(input.namedStaffable))
    : 0;
  const surplus = Math.max(0, named + assigned - floor);
  const previous = input.previousNamedStaffable;
  const newlyWarm =
    previous == null
      ? 0
      : Math.max(0, named - Math.max(0, Math.floor(previous)));
  // One per newly-warm named seat, and any extras past 40. The
  // floor wins: never return more than surplus.
  return Math.min(assigned, Math.max(surplus, newlyWarm), surplus);
}

export function pickNamedWarmSwapReturns<T extends Pick<GenericSeatRecord, "email" | "assignedAt">>(
  seats: T[],
  count: number,
): T[] {
  if (count <= 0) return [];
  return rankGenericsOldestWorstFirst(seats).slice(0, count);
}
