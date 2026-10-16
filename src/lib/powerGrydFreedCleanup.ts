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
  if (input.assignedClientId === powerId) return true;
  return (
    String(input.assignedReason ?? "").trim().toLowerCase() ===
    GENERIC_ASSIGN_REASON_POWERGRYD
  );
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
        reason: "onboarding_freed_powergryd",
      });
    } else if (typeof state.upsertGenericSeat === "function") {
      state.upsertGenericSeat(
        applyReleaseGenericSeat(seat, {
          now,
          reason: "onboarding_freed_powergryd",
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
  for (const account of input.accounts) {
    if (typeof account.client_id === "number" && Number.isFinite(account.client_id)) {
      continue;
    }
    const email = accountEmail(account);
    if (!email) continue;
    if (input.isGeneric && !input.isGeneric(account, email)) continue;
    const key = genericSeatKey(email);
    const pool = input.state.getPoolMailbox(key);
    const seat = input.state.getGenericSeat?.(key);
    if (
      !isFreedPowerGrydPoolOwner({
        mailboxClientId: account.client_id,
        assignedClientId: pool?.assignedClientId ?? seat?.assignedClientId ?? null,
        assignedReason: seat?.reason,
        powerGrydClientId: powerId,
      })
    ) {
      continue;
    }
    if (clearFreedPowerGrydPoolOwner(input.state, email, { now, powerGrydClientId: powerId })) {
      cleared.push({
        email: key,
        accountId: typeof account.id === "number" ? account.id : null,
      });
    }
  }
  return { cleared };
}
