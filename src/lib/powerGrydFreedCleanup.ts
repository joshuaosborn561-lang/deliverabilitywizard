/**
 * D283 — Onboarding-freed PowerGRYD generics.
 *
 * Smartlead `client_id=null` is authoritative. A leftover pool /
 * table row that still names 592842 with reason `powergryd_dedicated`
 * must not invent an owner or restaff the seat onto PowerGRYD.
 * Clears owner + reason for those generic-domain seats (the 85
 * Onboarding freed, e.g. 21592200 / 21592202). Idempotent.
 */

import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import { accountEmail } from "../clients/smartlead.js";
import type { PoolMailboxRecord } from "../state/store.js";
import {
  GENERIC_ASSIGN_REASON_POWERGRYD,
  GENERIC_POOL_POWERGRYD_CLIENT_ID,
  applyReleaseGenericSeat,
  genericSeatKey,
  isPowerGrydDedicatedSeat,
  type GenericSeatRecord,
} from "./genericPool.js";
import { POWERGRYD_CLIENT_ID, isPowerGrydClientId } from "./namedClientIds.js";

/** Production examples Onboarding freed (generic-domain, SL client_id null). */
export const FREED_POWERGRYD_GENERIC_ACCOUNT_IDS: readonly number[] = [
  21592200, 21592202,
];

export const ONBOARDING_FREED_POWERGRYD_REASON = "onboarding_freed_powergryd";

export function seatWasOnboardingFreedPowerGryd(
  seat?: {
    reason?: string | null;
    releaseHistory?: Array<{ reason?: string | null }>;
  } | null,
): boolean {
  if (!seat) return false;
  const reasons = [
    seat.reason,
    ...(seat.releaseHistory ?? []).map((event) => event.reason),
  ];
  return reasons.some(
    (reason) =>
      String(reason ?? "").trim().toLowerCase() === ONBOARDING_FREED_POWERGRYD_REASON,
  );
}

/** D283 / D290 — Onboarding-freed generics must not flip back onto PowerGRYD. They are free-pool supply for every other named client. */
export function isFreedPowerGrydAttachBlocked(input: {
  mailboxClientId?: number | null;
  assignedClientId?: number | null;
  assignedReason?: string | null;
  releaseHistory?: Array<{ reason?: string | null }>;
  powerGrydClientId?: number;
}): boolean {
  if (
    typeof input.mailboxClientId === "number" &&
    Number.isFinite(input.mailboxClientId)
  ) {
    return false;
  }
  if (
    isFreedPowerGrydPoolOwner({
      mailboxClientId: input.mailboxClientId,
      assignedClientId: input.assignedClientId,
      assignedReason: input.assignedReason,
      powerGrydClientId: input.powerGrydClientId,
    })
  ) {
    return true;
  }
  return seatWasOnboardingFreedPowerGryd({
    reason: input.assignedReason,
    releaseHistory: input.releaseHistory,
  });
}

export function isFreedPowerGrydPoolOwner(input: {
  mailboxClientId?: number | null;
  assignedClientId?: number | null;
  assignedReason?: string | null;
  powerGrydClientId?: number;
}): boolean {
  if (typeof input.mailboxClientId === "number" && Number.isFinite(input.mailboxClientId)) {
    return false;
  }
  const powerId = input.powerGrydClientId ?? POWERGRYD_CLIENT_ID;
  const assigned = input.assignedClientId;
  // Leftover `powergryd_dedicated` on a seat already owned by another
  // named client is not a free — clearing it every pass restaffed the
  // fleet and pinned inventory / min40 / generic-cleanup (D283).
  if (typeof assigned === "number" && Number.isFinite(assigned) && assigned !== powerId) {
    return false;
  }
  if (assigned === powerId) return true;
  return (
    String(input.assignedReason ?? "").trim().toLowerCase() ===
    GENERIC_ASSIGN_REASON_POWERGRYD
  );
}

/**
 * D283 — one-client must peel leftover 592842 links and then stop.
 * Cleanup clears owner/reason in the same pass, so the leftover-owner
 * check alone misses the seat and D76 dumps it onto Goliath (the
 * write storm that timed out inventory / min40 / generic-cleanup).
 */
export function isFreedPowerGrydOneClientSkip(input: {
  generic: boolean;
  mailboxClientId?: number | null;
  assignedClientId?: number | null;
  assignedReason?: string | null;
  releaseHistory?: Array<{ reason?: string | null }>;
  justCleared?: boolean;
  hasPowerGrydMembership?: boolean;
  powerGrydClientId?: number;
}): boolean {
  if (!input.generic) return false;
  if (
    typeof input.mailboxClientId === "number" &&
    Number.isFinite(input.mailboxClientId)
  ) {
    return false;
  }
  if (
    isFreedPowerGrydPoolOwner({
      mailboxClientId: input.mailboxClientId,
      assignedClientId: input.assignedClientId,
      assignedReason: input.assignedReason,
      powerGrydClientId: input.powerGrydClientId,
    })
  ) {
    return true;
  }
  if (input.justCleared) return true;
  if (
    isFreedPowerGrydAttachBlocked({
      mailboxClientId: input.mailboxClientId,
      assignedClientId: input.assignedClientId,
      assignedReason: input.assignedReason,
      releaseHistory: input.releaseHistory,
      powerGrydClientId: input.powerGrydClientId,
    })
  ) {
    return true;
  }
  const assigned = input.assignedClientId;
  const otherNamedOwner =
    typeof assigned === "number" &&
    Number.isFinite(assigned) &&
    assigned !== (input.powerGrydClientId ?? POWERGRYD_CLIENT_ID) &&
    !isPowerGrydClientId(assigned);
  return Boolean(input.hasPowerGrydMembership) && !otherNamedOwner;
}

export function poolLooksFreedPowerGryd(
  pool:
    | Pick<PoolMailboxRecord, "assignedClientId">
    | { assignedClientId?: number | null }
    | null
    | undefined,
  powerGrydClientId: number = GENERIC_POOL_POWERGRYD_CLIENT_ID,
): boolean {
  return isPowerGrydClientId(pool?.assignedClientId ?? null) ||
    pool?.assignedClientId === powerGrydClientId;
}

export interface FreedPowerGrydCleanupState {
  getPoolMailbox: (email: string) => PoolMailboxRecord | undefined;
  upsertPoolMailbox?: (record: PoolMailboxRecord) => void;
  getGenericSeat?: (email: string) => GenericSeatRecord | undefined;
  upsertGenericSeat?: (record: GenericSeatRecord) => void;
  releaseGenericFromTable?: (
    email: string,
    opts?: { now?: Date; reason?: string | null },
  ) => GenericSeatRecord | null;
  listPoolMailboxes?: () => Array<Pick<PoolMailboxRecord, "email" | "assignedClientId">>;
  listGenericSeats?: () => GenericSeatRecord[];
}

export interface FreedPowerGrydCleanupResult {
  cleared: Array<{ email: string; accountId: number | null }>;
}

export function clearFreedPowerGrydPoolOwner(
  state: FreedPowerGrydCleanupState,
  email: string,
  opts: { now?: Date; powerGrydClientId?: number } = {},
): boolean {
  const key = genericSeatKey(email);
  const powerId = opts.powerGrydClientId ?? POWERGRYD_CLIENT_ID;
  const now = opts.now ?? new Date();
  let changed = false;
  const pool = state.getPoolMailbox(key);
  if (
    pool &&
    typeof state.upsertPoolMailbox === "function" &&
    poolLooksFreedPowerGryd(pool, powerId)
  ) {
    state.upsertPoolMailbox({
      ...pool,
      status: pool.status === "assigned" ? "available" : pool.status,
      assignedClientId: null,
      assignedClientName: undefined,
      assignedAt: undefined,
    });
    changed = true;
  }
  const seat = state.getGenericSeat?.(key);
  if (seat && isPowerGrydDedicatedSeat(seat, powerId)) {
    if (typeof state.releaseGenericFromTable === "function") {
      state.releaseGenericFromTable(key, {
        now,
        reason: ONBOARDING_FREED_POWERGRYD_REASON,
      });
    } else if (typeof state.upsertGenericSeat === "function") {
      state.upsertGenericSeat(
        applyReleaseGenericSeat(seat, {
          now,
          reason: ONBOARDING_FREED_POWERGRYD_REASON,
        }),
      );
    }
    changed = true;
  }
  return changed;
}

/**
 * One-time (idempotent) cleanup: generic-domain seats whose live
 * Smartlead `client_id` is null and whose pool/table still names
 * PowerGRYD / `powergryd_dedicated`.
 */
export function cleanupFreedPowerGrydGenerics(input: {
  accounts: Iterable<SmartleadAccountWithCampaigns>;
  state: FreedPowerGrydCleanupState;
  isGeneric?: (account: SmartleadAccountWithCampaigns, email: string) => boolean;
  now?: Date;
  powerGrydClientId?: number;
}): FreedPowerGrydCleanupResult {
  const powerId = input.powerGrydClientId ?? POWERGRYD_CLIENT_ID;
  const now = input.now ?? new Date();
  const cleared: FreedPowerGrydCleanupResult["cleared"] = [];
  const byEmail = new Map<string, SmartleadAccountWithCampaigns>();
  const byId = new Map<number, SmartleadAccountWithCampaigns>();
  for (const account of input.accounts) {
    const email = accountEmail(account);
    if (email) byEmail.set(genericSeatKey(email), account);
    if (typeof account.id === "number" && Number.isFinite(account.id)) {
      byId.set(account.id, account);
    }
  }

  const candidates = new Set<string>();
  for (const id of FREED_POWERGRYD_GENERIC_ACCOUNT_IDS) {
    const account = byId.get(id);
    const email = account ? accountEmail(account) : null;
    if (email) candidates.add(genericSeatKey(email));
  }
  const canListPool = typeof input.state.listPoolMailboxes === "function";
  const canListSeats = typeof input.state.listGenericSeats === "function";
  if (canListPool) {
    for (const pool of input.state.listPoolMailboxes!()) {
      if (!pool.email) continue;
      if (poolLooksFreedPowerGryd(pool, powerId)) {
        candidates.add(genericSeatKey(pool.email));
      }
    }
  }
  if (canListSeats) {
    for (const seat of input.state.listGenericSeats!()) {
      if (isPowerGrydDedicatedSeat(seat, powerId)) {
        candidates.add(genericSeatKey(seat.email));
      }
    }
  }
  if (!canListPool && !canListSeats) {
    for (const account of input.accounts) {
      if (typeof account.client_id === "number" && Number.isFinite(account.client_id)) {
        continue;
      }
      const email = accountEmail(account);
      if (email) candidates.add(genericSeatKey(email));
    }
  }

  for (const key of candidates) {
    const account = byEmail.get(key);
    if (
      account &&
      typeof account.client_id === "number" &&
      Number.isFinite(account.client_id)
    ) {
      continue;
    }
    if (account && input.isGeneric && !input.isGeneric(account, key)) continue;
    const pool = input.state.getPoolMailbox(key);
    const seat = input.state.getGenericSeat?.(key);
    if (
      !isFreedPowerGrydPoolOwner({
        mailboxClientId: account?.client_id,
        assignedClientId: pool?.assignedClientId ?? seat?.assignedClientId ?? null,
        assignedReason: seat?.reason,
        powerGrydClientId: powerId,
      })
    ) {
      continue;
    }
    if (clearFreedPowerGrydPoolOwner(input.state, key, { now, powerGrydClientId: powerId })) {
      cleared.push({
        email: key,
        accountId: typeof account?.id === "number" ? account.id : null,
      });
    }
  }
  return { cleared };
}
