/**
 * D212 — D148 bounce-hold seats stay at their current daily cap.
 *
 * Tenant-cap triage zeros Outlook `max_email_per_day` until ~00:15 UTC
 * (7:15pm CT) after Microsoft's midnight reset. mailbox-gap / health
 * D183 converge must not write those seats back to 15. This module
 * never writes a daily limit — it only says "skip".
 *
 * The hold list is keyed by Smartlead account id. A seat is held when
 * its id is on the list and the restore window is still open, or when
 * it is Outlook already at 0 during that same window (Josh's re-zero
 * after a gap pass, before the id is persisted).
 */

import { isOutlookMailboxType } from "./sendCeiling.js";

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

export interface BounceHoldReader {
  isBounceHoldWindowActive?(now?: Date): boolean;
  isBounceHoldAccount?(accountId: number, now?: Date): boolean;
}

export function accountOnBounceHold(
  account: {
    id?: number | null;
    type?: string | null;
    platform?: string | null;
    message_per_day?: number | string;
    max_email_per_day?: number;
  },
  store?: BounceHoldReader | null,
  now = new Date(),
): boolean {
  const id = Number(account.id);
  if (!Number.isFinite(id) || id <= 0) return false;
  if (store?.isBounceHoldAccount?.(id, now) === true) return true;
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
