/**
 * D208 — Outlook seats on an explicit tenant-zero hold stay at
 * `max_email_per_day` 0 until ~00:15 UTC (7:15pm CT) after the
 * Microsoft daily cap day. Campaigns stay ACTIVE (D148). No peel,
 * no pause, no Retire. D183 15-converge resumes after restore.
 *
 * Seeded ids are Josh-named senders on that tenant — not "every
 * Outlook sibling" (that is how TechEvo got zeroed by a wrong
 * tenant page).
 */

export const GETINTRODUCEDNOW_TENANT = "getintroducednow.com";
export const SALESGLIDERGET_TENANT = "salesgliderget.info";
export const SALESGLIDERLAB_TENANT = "salesgliderlab.info";
export const NOWGETINTRODUCED_TENANT = "nowgetintroduced.com";

/** Josh 2026-09-29 — getintroducednow.com Outlook seats, mpd zero only. */
export const GETINTRODUCEDNOW_TENANT_ZERO_IDS = [
  21648785, // jinmorgan Insight
  21648784, // aaravrossi Parlay
  21648783, // hanajefferson EMCOR
  21648777, // lanreed PowerGRYD — not peeled
  21648693, // minhjenkins BCP
] as const;

/** Josh 2026-09-29 ACK — salesgliderget.info Outlook, mpd zero only. */
export const SALESGLIDERGET_TENANT_ZERO_IDS = [
  16427892, // joshuaosborn@salesgliderget.info
] as const;

/** Josh 2026-09-29 ACK — salesgliderlab.info Outlook, mpd zero only. */
export const SALESGLIDERLAB_TENANT_ZERO_IDS = [
  16427893, // joshua@salesgliderlab.info
  16427897, // joborn@salesgliderlab.info
  16427941, // joshuaosborn@salesgliderlab.info
] as const;

/** Josh 2026-09-29 ACK — nowgetintroduced.com on-camp already-0. */
export const NOWGETINTRODUCED_TENANT_ZERO_IDS = [
  21648788, // kofichen@nowgetintroduced.com
] as const;

export const TENANT_ZERO_BY_DOMAIN: Record<string, readonly number[]> = {
  [GETINTRODUCEDNOW_TENANT]: GETINTRODUCEDNOW_TENANT_ZERO_IDS,
  [SALESGLIDERGET_TENANT]: SALESGLIDERGET_TENANT_ZERO_IDS,
  [SALESGLIDERLAB_TENANT]: SALESGLIDERLAB_TENANT_ZERO_IDS,
  [NOWGETINTRODUCED_TENANT]: NOWGETINTRODUCED_TENANT_ZERO_IDS,
};

/** 15 minutes after UTC midnight ≈ 7:15pm CT. */
export const TENANT_ZERO_RESTORE_GRACE_MINUTES = 15;

export function tenantLimitAlertKey(domain: string, dayYmd: string): string {
  return `tenant-limit:${domain.toLowerCase()}:${dayYmd}`;
}

export function tenantZeroIdsForDomain(domain: string): readonly number[] {
  return TENANT_ZERO_BY_DOMAIN[domain.toLowerCase()] ?? [];
}

export function nextTenantZeroRestoreAt(now: Date): Date {
  const restore = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      TENANT_ZERO_RESTORE_GRACE_MINUTES,
      0,
      0,
    ),
  );
  if (now.getTime() >= restore.getTime()) {
    restore.setUTCDate(restore.getUTCDate() + 1);
  }
  return restore;
}

export function utcDayYmd(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Safe on partial test stores that omit the D208 methods. */
export function storeHoldsTenantZero(
  store:
    | { isTenantZeroActive?(id: number, now?: Date): boolean }
    | null
    | undefined,
  accountId: number | null | undefined,
  now?: Date,
): boolean {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) return false;
  return store?.isTenantZeroActive?.(id, now) === true;
}
