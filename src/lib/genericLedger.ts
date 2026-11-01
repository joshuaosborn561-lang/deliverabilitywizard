/**
 * D286 — Generics Ledger helpers. Wizard `state.genericSeats` is the
 * source of truth. Every assign / release / warmup / covering_for
 * link goes through the existing table.
 */

import { emailDomainOf } from "./isolationDomain.js";
import { clientNamedSlugInDomain } from "./clientNamedDomain.js";
import {
  DEEP_ROOTS_CLIENT_ID,
  PETERSON_CLIENT_ID,
} from "./namedClientIds.js";
import { INSIGHT_CLIENT_ID } from "./insightCampaigns.js";
import {
  GENERIC_POOL_POD_FLOOR,
  clientPodKey,
  genericSeatKey,
  seatStaffableWeight,
  type GenericAssignedPod,
  type GenericCoveringFor,
  type GenericSeatRecord,
} from "./genericPool.js";
import { minFloorForClient } from "./minFloorByClient.js";
import { rankGenericsOldestWorstFirst } from "./genericAssign.js";
import { DEFAULT_WARMUP_DAYS } from "./warmupDays.js";

export const GENERIC_LEDGER_WARMUP_DAYS = DEFAULT_WARMUP_DAYS;

export function isCornerstoneGenericDomain(
  emailOrDomain: string | null | undefined,
): boolean {
  const domain = emailOrDomain?.includes("@")
    ? emailDomainOf(emailOrDomain)
    : String(emailOrDomain ?? "").trim().toLowerCase();
  if (!domain) return false;
  return clientNamedSlugInDomain(domain) === "cornerstone";
}

export function isInsightClientId(id: number | null | undefined): boolean {
  return id === INSIGHT_CLIENT_ID;
}

export function ledgerNoRestaffClientId(
  id: number | null | undefined,
): boolean {
  return id === PETERSON_CLIENT_ID || id === DEEP_ROOTS_CLIENT_ID;
}

export function warmReadyAtFromClock(
  startedAt: string | null | undefined,
  days = GENERIC_LEDGER_WARMUP_DAYS,
  now = new Date(),
): string | null {
  if (startedAt && Number.isFinite(Date.parse(startedAt))) {
    return new Date(Date.parse(startedAt) + days * 86_400_000).toISOString();
  }
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

export function coveringForIsReady(
  covering: GenericCoveringFor,
  now = new Date(),
): boolean {
  if (!covering.warmReadyAt) return false;
  const at = Date.parse(covering.warmReadyAt);
  return Number.isFinite(at) && at <= now.getTime();
}

export function seatCoveringReady(
  seat: Pick<GenericSeatRecord, "coveringFor">,
  now = new Date(),
): GenericCoveringFor[] {
  return (seat.coveringFor ?? []).filter((row) => coveringForIsReady(row, now));
}

export interface WarmingBrandedSeat {
  email: string;
  clientId: number;
  pod: GenericAssignedPod;
  warmReadyAt: string | null;
}

function sortWarmingSoonestFirst(
  a: WarmingBrandedSeat,
  b: WarmingBrandedSeat,
): number {
  const aAt = Date.parse(a.warmReadyAt ?? "") || Number.POSITIVE_INFINITY;
  const bAt = Date.parse(b.warmReadyAt ?? "") || Number.POSITIVE_INFINITY;
  if (aAt !== bAt) return aAt - bAt;
  return a.email.localeCompare(b.email);
}

/**
 * D289 — index warming branded seats once so covering_for relink is
 * O(need) per generic, not O(warming) filter+sort on every seat.
 */
export function warmingSeatsByClientPod(
  warming: Iterable<WarmingBrandedSeat>,
): Map<string, WarmingBrandedSeat[]> {
  const out = new Map<string, WarmingBrandedSeat[]>();
  for (const row of warming) {
    const key = clientPodKey(row.clientId, row.pod);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  for (const list of out.values()) list.sort(sortWarmingSoonestFirst);
  return out;
}

/**
 * Link a generic to the soonest-warming uncovered branded seats in
 * that client POD. One branded seat per staffable weight (usually 1).
 */
export function linkCoveringFor(input: {
  seat: Pick<GenericSeatRecord, "coveringFor" | "staffableWeight" | "assignedClientId" | "assignedPod">;
  warming: WarmingBrandedSeat[];
  alreadyCovered: Iterable<string>;
  now?: Date;
  /** Pre-indexed, already sorted. Skip the O(warming) filter+sort. */
  warmingByPod?: ReadonlyMap<string, readonly WarmingBrandedSeat[]>;
}): GenericCoveringFor[] {
  const clientId = input.seat.assignedClientId;
  const pod = input.seat.assignedPod;
  if (clientId == null || pod == null) return [];
  const indexed = input.warmingByPod?.get(clientPodKey(clientId, pod));
  const keep = (input.seat.coveringFor ?? []).filter((row) => {
    if (coveringForIsReady(row, input.now)) return false;
    const pool = indexed ?? input.warming;
    return pool.some(
      (named) =>
        genericSeatKey(named.email) === row.email &&
        named.clientId === clientId &&
        named.pod === pod,
    );
  });
  const covered = new Set([
    ...[...input.alreadyCovered].map((email) => genericSeatKey(email)),
    ...keep.map((row) => row.email),
  ]);
  const need = Math.max(1, Math.ceil(seatStaffableWeight(input.seat)));
  const open = indexed
    ? indexed.filter((row) => !covered.has(genericSeatKey(row.email)))
    : input.warming
        .filter(
          (row) =>
            row.clientId === clientId &&
            row.pod === pod &&
            !covered.has(genericSeatKey(row.email)),
        )
        .sort(sortWarmingSoonestFirst);
  const next = [...keep];
  for (const row of open) {
    if (next.length >= need) break;
    next.push({
      email: genericSeatKey(row.email),
      warmReadyAt: row.warmReadyAt,
    });
    covered.add(genericSeatKey(row.email));
  }
  return next;
}

export function alreadyCoveredEmails(
  seats: Iterable<Pick<GenericSeatRecord, "coveringFor" | "email">>,
  exceptEmail?: string,
): Set<string> {
  const skip = exceptEmail ? genericSeatKey(exceptEmail) : "";
  const out = new Set<string>();
  for (const seat of seats) {
    if (skip && genericSeatKey(seat.email) === skip) continue;
    for (const row of seat.coveringFor ?? []) {
      out.add(genericSeatKey(row.email));
    }
  }
  return out;
}

export interface CoveringSwapPick {
  email: string;
  clientId: number;
  pod: GenericAssignedPod | null;
  attachBranded: string[];
  via: "covering_for" | "headcount";
}

/**
 * Per-seat named-warm swap. A generic whose coveringFor branded
 * seat is past warmReadyAt comes out (and that branded seat goes
 * in) without dropping the POD below floor. Headcount surplus is
 * only the fallback for unlinked seats.
 */
export function pickCoveringForReturns(input: {
  seats: GenericSeatRecord[];
  namedStaffable: number;
  floor?: number;
  now?: Date;
  /** Skip Deep Roots / Peterson restaff — return empty attach list. */
  noRestaff?: boolean;
}): CoveringSwapPick[] {
  const now = input.now ?? new Date();
  const floor = input.floor ?? GENERIC_POOL_POD_FLOOR;
  const named = Math.max(0, input.namedStaffable);
  const assigned = input.seats;
  let remaining =
    named + assigned.reduce((sum, seat) => sum + seatStaffableWeight(seat), 0);
  const out: CoveringSwapPick[] = [];

  const linkedReady = rankGenericsOldestWorstFirst(
    assigned.filter((seat) => seatCoveringReady(seat, now).length > 0),
  );
  for (const seat of linkedReady) {
    const weight = seatStaffableWeight(seat);
    if (remaining - weight + 1 < floor - 1e-9) continue;
    remaining -= weight;
    remaining += input.noRestaff ? 0 : 1;
    out.push({
      email: seat.email,
      clientId: seat.assignedClientId!,
      pod: seat.assignedPod,
      attachBranded: input.noRestaff
        ? []
        : seatCoveringReady(seat, now).map((row) => row.email),
      via: "covering_for",
    });
  }

  return out;
}

export function freeWarmGenericCount(
  seats: Iterable<Pick<GenericSeatRecord, "assignedClientId" | "warmupEnabled" | "excluded" | "warmReadyAt">>,
  now = new Date(),
): number {
  let n = 0;
  for (const seat of seats) {
    if (seat.excluded) continue;
    if (seat.assignedClientId != null) continue;
    if (seat.warmupEnabled === false) continue;
    if (seat.warmReadyAt) {
      const at = Date.parse(seat.warmReadyAt);
      if (Number.isFinite(at) && at > now.getTime()) continue;
    }
    n += 1;
  }
  return n;
}

export function podShortNoFreeGeneric(
  input: {
    namedStaffable: number;
    assignedWeight: number;
    freeWarm: number;
    clientId: number;
    minFloorByClient?: Readonly<Record<number, number>>;
  },
): boolean {
  const floor = minFloorForClient(input.clientId, input.minFloorByClient);
  const owned = input.namedStaffable + input.assignedWeight;
  return owned + 1e-9 < floor && input.freeWarm <= 0;
}

export function clientPodFromKey(key: string): {
  clientId: number;
  pod: GenericAssignedPod;
} | null {
  const [raw, podRaw] = key.split(":");
  const clientId = Number(raw);
  const pod = podRaw === "A" || podRaw === "B" ? podRaw : null;
  if (!Number.isFinite(clientId) || clientId <= 0 || !pod) return null;
  return { clientId, pod };
}

export { clientPodKey };

export interface GenericLedgerCleanupStamp {
  ranAt: string;
  insightReleased: number;
  cornerstoneExcluded: number;
  tagsStripped: number;
  powergrydFindingsCleared: number;
}

export function suppressPodFloorAlert(clientId: number | null | undefined): boolean {
  return clientId === PETERSON_CLIENT_ID;
}

export function isFreeWarmLedgerSeat(
  seat: Pick<
    GenericSeatRecord,
    | "assignedClientId"
    | "warmupEnabled"
    | "excluded"
    | "warmReadyAt"
    | "email"
  >,
  now = new Date(),
): boolean {
  if (seat.excluded) return false;
  if (isCornerstoneGenericDomain(seat.email)) return false;
  if (seat.assignedClientId != null) return false;
  if (seat.warmReadyAt) {
    const at = Date.parse(seat.warmReadyAt);
    if (Number.isFinite(at) && at > now.getTime()) return false;
  }
  return true;
}

export function pendingRetireDomains(input: {
  actions?: Iterable<{
    kind?: string | null;
    status?: string | null;
    detail?: Record<string, unknown> | null;
  }>;
  history?: Iterable<{ domain?: string | null; status?: string | null }>;
}): Set<string> {
  const out = new Set<string>();
  for (const action of input.actions ?? []) {
    if (action.kind !== "retire_domain") continue;
    const status = String(action.status ?? "").toLowerCase();
    if (status !== "pending" && status !== "approved") continue;
    for (const key of ["domain", "retiredDomain"] as const) {
      const raw = action.detail?.[key];
      if (typeof raw === "string" && raw.includes(".")) {
        out.add(raw.trim().toLowerCase());
      }
    }
  }
  for (const row of input.history ?? []) {
    if (row.status !== "retire_pending") continue;
    const domain = String(row.domain ?? "").trim().toLowerCase();
    if (domain) out.add(domain);
  }
  return out;
}

/**
 * Free warm ledger seats for a short POD. CornerStone never.
 * Domains with a pending Retire card go last.
 */
export function pickFreeWarmGenericsForPod(input: {
  seats: GenericSeatRecord[];
  need: number;
  alreadyPicked?: Iterable<string>;
  retirePendingDomains?: Iterable<string>;
  now?: Date;
  /**
   * D292 — return more than `need` so ESP mix can skip a wrong-family
   * seat without starving the POD. Default = need.
   */
  limit?: number;
  preferProvider?: "GOOGLE" | "MICROSOFT";
}): GenericSeatRecord[] {
  const need = Number(input.need);
  if (!Number.isFinite(need) || need <= 1e-9) return [];
  const limitRaw = Number(input.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.max(need, limitRaw) : need;
  const picked = new Set(
    [...(input.alreadyPicked ?? [])].map((email) => genericSeatKey(email)),
  );
  const retire = new Set(
    [...(input.retirePendingDomains ?? [])].map((domain) =>
      String(domain).trim().toLowerCase(),
    ),
  );
  const now = input.now ?? new Date();
  const prefer = input.preferProvider;
  const free = input.seats.filter(
    (seat) => isFreeWarmLedgerSeat(seat, now) && !picked.has(genericSeatKey(seat.email)),
  );
  free.sort((a, b) => {
    if (prefer) {
      const aPref = a.provider === prefer ? 0 : 1;
      const bPref = b.provider === prefer ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
    }
    const aRetire = retire.has(emailDomainOf(a.email) ?? "") ? 1 : 0;
    const bRetire = retire.has(emailDomainOf(b.email) ?? "") ? 1 : 0;
    if (aRetire !== bRetire) return aRetire - bRetire;
    return a.email.localeCompare(b.email);
  });
  const out: GenericSeatRecord[] = [];
  let placed = 0;
  for (const seat of free) {
    if (placed + 1e-9 >= limit) break;
    out.push(seat);
    placed += seatStaffableWeight(seat);
  }
  return out;
}

export function parseGenericLedgerCleanupStamp(
  raw: unknown,
): GenericLedgerCleanupStamp | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<GenericLedgerCleanupStamp>;
  if (typeof row.ranAt !== "string" || !row.ranAt.trim()) return null;
  return {
    ranAt: row.ranAt,
    insightReleased: Number(row.insightReleased) || 0,
    cornerstoneExcluded: Number(row.cornerstoneExcluded) || 0,
    tagsStripped: Number(row.tagsStripped) || 0,
    powergrydFindingsCleared: Number(row.powergrydFindingsCleared) || 0,
  };
}
