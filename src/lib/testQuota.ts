/**
 * D45 — SmartDelivery test quota.
 *
 * `0` means unlimited (Josh has no plan cap). A positive value still
 * enforces the old D8 block-before-creating behaviour. Do not treat 0 as
 * "zero slots left".
 */
export function isUnlimitedTestQuota(quota: number): boolean {
  return !Number.isFinite(quota) || quota <= 0;
}

export function remainingTestSlots(quota: number, used: number): number {
  if (isUnlimitedTestQuota(quota)) return Number.POSITIVE_INFINITY;
  return Math.max(0, quota - used);
}

export function quotaWouldBlock(
  quota: number,
  used: number,
  needed: number,
): boolean {
  if (isUnlimitedTestQuota(quota)) return false;
  return needed > remainingTestSlots(quota, used);
}
