/**
 * D212 / D218 — D148 bounce-hold seats stay at their current daily cap.
 *
 * Tenant-cap triage (550 5.7.233 / TERRL) zeros Outlook
 * `max_email_per_day`. mailbox-gap / health D183, min40, fan-out,
 * top-up, and canary setup must not write those seats back to 15.
 * This module never writes a daily limit — it only says "skip".
 *
 * D218 — the hold list is durable. A Smartlead account id on the list
 * stays held across the old 00:15 UTC / 7:15pm CT restore. That restore
 * is what put 36 SG Outlook seats back to 15 between 2026-09-30 and
 * 2026-10-02. A human (or a later measured-limit policy) clears the id.
 * Outlook already at 0 during an open TERRL window is still treated as
 * held so a re-zero before the id is persisted is not raised.
 */

import { isOutlookMailboxType } from "./sendCeiling.js";
import { accountOnTenantOutboundHold } from "./tenantOutboundBlock.js";
import { accountOnTenantTerlHold, type TenantTerlHoldStore } from "./tenantTerlHold.js";

/** 15 minutes after UTC midnight ≈ 7:15pm America/Chicago. */
export const BOUNCE_HOLD_RESTORE_GRACE_MINUTES = 15;

export function nextBounceHoldRestoreAt(now: Date): Date {
  const restore = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      BOUNCE_HOLD_RESTORE_GRACE_MINUTES,
      0,
      0,
    ),
  );
  if (now.getTime() >= restore.getTime()) {
    restore.setUTCDate(restore.getUTCDate() + 1);
  }
  return restore;
}

export function bounceHoldWindowActive(
  restoreAfter: string | null | undefined,
  now: Date,
): boolean {
  if (!restoreAfter) return false;
  const at = Date.parse(restoreAfter);
  return Number.isFinite(at) && now.getTime() < at;
}

export function utcDayYmd(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function tenantLimitAlertKey(domain: string, dayYmd: string): string {
  return `tenant-limit:${domain.toLowerCase()}:${dayYmd}`;
}

export function hasTodayTenantCapSignal(
  input: {
    alertedKeys?: Record<string, string>;
    bounceVerdicts?: Array<{ dominant?: string | null; at?: string }>;
  },
  now: Date,
): boolean {
  const day = utcDayYmd(now);
  for (const key of Object.keys(input.alertedKeys ?? {})) {
    if (key.startsWith("tenant-limit:") && key.endsWith(`:${day}`)) {
      return true;
    }
  }
  return (input.bounceVerdicts ?? []).some(
    (row) =>
      row.dominant === "tenant_rate_limit" &&
      typeof row.at === "string" &&
      row.at.slice(0, 10) === day,
  );
}

export interface BounceHoldReader extends Partial<TenantTerlHoldStore> {
  isBounceHoldWindowActive?(now?: Date): boolean;
  isBounceHoldAccount?(accountId: number, now?: Date): boolean;
  isTenantOutboundBlockAccount?(accountId: number): boolean;
  isTenantOutboundBlockDomain?(domain: string): boolean;
}

export function accountOnBounceHold(
  account: {
    id?: number | null;
    type?: string | null;
    platform?: string | null;
    from_email?: string | null;
    email?: string | null;
    message_per_day?: number | string;
    max_email_per_day?: number;
  },
  store?: BounceHoldReader | null,
  now = new Date(),
): boolean {
  if (
    accountOnTenantOutboundHold(account, {
      isTenantOutboundBlockAccount: (id) =>
        store?.isTenantOutboundBlockAccount?.(id) === true,
      isTenantOutboundBlockDomain: (domain) =>
        store?.isTenantOutboundBlockDomain?.(domain) === true,
    })
  ) {
    return true;
  }
  if (
    accountOnTenantTerlHold(
      account,
      {
        isTenantTerlHoldAccount: (id, at) =>
          store?.isTenantTerlHoldAccount?.(id, at) === true,
        isTenantTerlHoldDomain: (domain, at) =>
          store?.isTenantTerlHoldDomain?.(domain, at) === true,
      },
      now,
    )
  ) {
    return true;
  }
  const id = Number(account.id);
  if (!Number.isFinite(id) || id <= 0) return false;
  if (store?.isBounceHoldAccount?.(id, now) === true) return true;
  // Unlisted Outlook at 0 is held only while a TERRL window is open
  // (re-zero before the id is persisted). Listed ids stay held even
  // after that window (D218).
  if (!store?.isBounceHoldWindowActive?.(now)) return false;
  if (!isOutlookMailboxType(account.type ?? account.platform)) return false;
  const raw = account.message_per_day ?? account.max_email_per_day;
  const current =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  return current === 0;
}

/**
 * True when a writer must not raise this seat's campaign daily cap.
 * Writing 0 to keep a held seat at 0 is allowed; writing 15/30 is not.
 */
export function mustNotRaiseHeldMpd(
  account: Parameters<typeof accountOnBounceHold>[0],
  store?: BounceHoldReader | null,
  now = new Date(),
): boolean {
  return accountOnBounceHold(account, store, now);
}
