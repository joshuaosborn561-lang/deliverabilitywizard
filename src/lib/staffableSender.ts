import type { SmartleadEmailAccount } from "../types/index.js";

/**
 * A sender counts toward the campaign floor only when it can actually send
 * and is not already known to be spammy / recovering. Disconnected and held
 * memberships do not staff a campaign (D25).
 */

export function isConnectedAccount(
  account: Pick<SmartleadEmailAccount, "is_smtp_success" | "is_imap_success">,
): boolean {
  // Unknown connectivity is treated as connected so a partial Smartlead
  // payload cannot mass-understaff every campaign. Explicit false is the only
  // disconnect signal.
  return (
    account.is_smtp_success !== false && account.is_imap_success !== false
  );
}

export function parseWarmupReputation(
  account: Pick<SmartleadEmailAccount, "warmup_details">,
): number | null {
  const raw = account.warmup_details?.warmup_reputation;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw.replace(/%/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface StaffableOptions {
  /** D43 — a resting inbox is not staffable. */
  resting?: boolean;
  /** D54/D55 — the canary fleet never staffs. */
  copyCanary?: boolean;
}

/**
 * Connected + not held + not warmup-blocked + not known-bad on placement.
 * Warmup reputation is intentionally ignored here — it is not an inboxing
 * signal, and using it under-counted live generics (TechEvo showed 29/87
 * "staffable" while SMTP/IMAP were fine). Measure/remediation owns spammy
 * removal; until a placement rate is known, connected membership staffs.
 */
export function isStaffableSender(
  account: Pick<
    SmartleadEmailAccount,
    "is_smtp_success" | "is_imap_success" | "warmup_details"
  >,
  options: StaffableOptions = {},
): boolean {
  if (!isConnectedAccount(account)) return false;
  if (options.resting) return false;
  if (options.copyCanary) return false;
  if (account.warmup_details?.is_warmup_blocked) return false;
  // D130 — the held/recovery tier and its placement-rate bar are gone;
  // kill-only (D51) means a connected, non-resting, non-canary inbox staffs.
  return true;
}
