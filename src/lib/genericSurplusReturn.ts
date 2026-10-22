/**
 * D225 / D230 — morning named-warm swap + surplus return.
 * One generic per named seat that goes warm, oldest / worst first,
 * plus any extras past 40. Returns to the untagged pool.
 * Active POC-engagement seats and an active 24h TERRL substitute stay.
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
import type { EspSlotFamily } from "./mailboxType.js";
import { minFloorForClient } from "./minFloorByClient.js";
import {
  ledgerNoRestaffClientId,
  pickCoveringForReturns,
} from "./genericLedger.js";

export const GENERIC_SURPLUS_RETURN_WEEKDAYS_ONLY = true;

export interface SurplusReturnCandidate {
  email: string;
  clientId: number;
  pod: string | null;
  attachBranded?: string[];
  via?: "covering_for" | "headcount";
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
  pocEngagementClientIds?: Iterable<number>;
  /** D256 — per-client min-floor; surplus is above this, not a hard 40. */
  minFloorByClient?: Readonly<Record<number, number>>;
  skipEmails?: Iterable<string>;
  now?: Date;
  weekdaysOnly?: boolean;
  /** D233 — named-warm swap returns the same ESP family that went warm. */
  preferEspSlot?: EspSlotFamily;
}): SurplusReturnCandidate[] {
  const now = input.now ?? new Date();
  const weekdaysOnly = input.weekdaysOnly ?? GENERIC_SURPLUS_RETURN_WEEKDAYS_ONLY;
  if (weekdaysOnly && !isChicagoWeekday(now)) return [];

  const powerId = input.powerGrydClientId ?? GENERIC_POOL_POWERGRYD_CLIENT_ID;
  const pocIds = [...(input.pocEngagementClientIds ?? [])];
  const skip = new Set(
    [...(input.skipEmails ?? [])].map((email) => genericSeatKey(email)),
  );
  void input.campaignClientById;
  void input.liveClientIdsByEmail;
  const grouped = new Map<string, GenericSeatRecord[]>();
  const unpodded: SurplusReturnCandidate[] = [];
  for (const seat of input.seats) {
    if (seat.assignedClientId == null) continue;
    if (
      genericPoolIdleExempt(seat, {
        powerGrydClientId: powerId,
        pocEngagementClientIds: pocIds,
      })
    ) {
      continue;
    }
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
    const floor = minFloorForClient(clientId, input.minFloorByClient);
    if (input.clientHasActiveCampaign?.get(clientId) === false) {
      for (const seat of rankGenericsOldestWorstFirst(seats)) {
        out.push({
          email: seat.email,
          clientId: seat.assignedClientId!,
          pod,
          via: "headcount",
        });
      }
      continue;
    }
    const covering = pickCoveringForReturns({
      seats,
      namedStaffable: named,
      floor,
      now,
      noRestaff: ledgerNoRestaffClientId(clientId),
    });
    const coveringEmails = new Set(covering.map((row) => row.email));
    for (const row of covering) {
      out.push({
        email: row.email,
        clientId: row.clientId,
        pod: row.pod,
        attachBranded: row.attachBranded,
        via: "covering_for",
      });
    }
    const unlinked = seats.filter((seat) => !coveringEmails.has(seat.email) && !seat.coveringFor?.length);
    const picked = pickWeightedGenericReturns(unlinked, {
      namedStaffable: named,
      preferEspSlot: input.preferEspSlot,
      floor,
    });
    for (const seat of picked) {
      out.push({
        email: seat.email,
        clientId: seat.assignedClientId!,
        pod,
        via: "headcount",
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
  ).map(({ email, clientId, pod, attachBranded, via }) => ({
    email,
    clientId,
    pod,
    attachBranded,
    via,
  }));
}

/** True when keeping this generic is required to hold the POD at 40. */
export function returningWouldDropPodBelow40(
  namedStaffable: number,
  assignedKept: number,
): boolean {
  return namedStaffable + assignedKept < GENERIC_POOL_POD_FLOOR;
}

/**
 * D298 — keep generic-surplus on the same POD count as min40-topup.
 * The surplus sync counted every tagged, warm named seat (linked or not)
 * while min40 counts owned staffable seats. A POD min40 saw as short
 * (e.g. 31.6/40) looked full to surplus, so the same day it returned the
 * generics min40 had just assigned. Here a pick is kept only while the
 * POD's owned count (per POD, never per campaign) stays at or above its
 * floor after the return. Clients with no active campaign are not guarded.
 */
export function guardSurplusByOwnedFloor<
  T extends { email: string; clientId: number; pod: string | null; via?: string },
>(input: {
  picks: readonly T[];
  ownedByClientPod: ReadonlyMap<string, { owned: number; floor: number; generics?: number }>;
  weightByEmail: ReadonlyMap<string, number>;
  clientHasActiveCampaign?: ReadonlyMap<number, boolean>;
  /** Clients whose returns keep their existing rule (PowerGRYD, D237). */
  unguardedClientIds?: Iterable<number>;
}): { kept: T[]; held: T[] } {
  const unguarded = new Set(input.unguardedClientIds ?? []);
  const remaining = new Map<string, { owned: number; generics: number }>();
  const kept: T[] = [];
  const held: T[] = [];
  for (const pick of input.picks) {
    if (!pick.pod || unguarded.has(pick.clientId) || input.clientHasActiveCampaign?.get(pick.clientId) === false) {
      kept.push(pick);
      continue;
    }
    const key = clientPodKey(pick.clientId, pick.pod as GenericAssignedPod);
    const row = input.ownedByClientPod.get(key);
    if (!row) {
      kept.push(pick);
      continue;
    }
    // Only generics min40 already counts can lower the owned total.
    const state = remaining.get(key) ?? {
      owned: row.owned,
      generics: row.generics ?? row.owned,
    };
    const weight = input.weightByEmail.get(genericSeatKey(pick.email)) ?? 0;
    const drop = Math.min(weight, Math.max(0, state.generics));
    if (state.owned - drop < row.floor) {
      held.push(pick);
      continue;
    }
    remaining.set(key, {
      owned: roundWeight(state.owned - drop),
      generics: roundWeight(state.generics - drop),
    });
    kept.push(pick);
  }
  return { kept, held };
}

function roundWeight(n: number): number {
  return Math.round(n * 100) / 100;
}
