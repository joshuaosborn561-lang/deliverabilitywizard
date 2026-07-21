export interface MonthlyUsageBucket {
  /** YYYY-MM (UTC) */
  month: string;
  domainSpendUsd: number;
  mailboxesCreated: number;
}

export function currentUtcMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function emptyMonthlyUsage(month = currentUtcMonth()): MonthlyUsageBucket {
  return { month, domainSpendUsd: 0, mailboxesCreated: 0 };
}

export function normalizeMonthlyUsage(
  raw: MonthlyUsageBucket | undefined,
  now = new Date(),
): MonthlyUsageBucket {
  const month = currentUtcMonth(now);
  if (!raw || raw.month !== month) return emptyMonthlyUsage(month);
  return {
    month,
    domainSpendUsd: Number(raw.domainSpendUsd) || 0,
    mailboxesCreated: Number(raw.mailboxesCreated) || 0,
  };
}

export function canBuyDomain(
  usage: MonthlyUsageBucket,
  priceUsd: number,
  capUsd: number,
): { ok: boolean; remaining: number; reason?: string } {
  const remaining = Math.max(0, capUsd - usage.domainSpendUsd);
  if (priceUsd > remaining + 1e-9) {
    return {
      ok: false,
      remaining,
      reason: `Domain $${priceUsd.toFixed(2)} would exceed $${capUsd}/mo cap ($${remaining.toFixed(2)} left)`,
    };
  }
  return { ok: true, remaining };
}

export function canCreateMailboxes(
  usage: MonthlyUsageBucket,
  count: number,
  cap: number,
): { ok: boolean; remaining: number; reason?: string } {
  const remaining = Math.max(0, cap - usage.mailboxesCreated);
  if (count > remaining) {
    return {
      ok: false,
      remaining,
      reason: `Need ${count} mailboxes but only ${remaining} left under ${cap}/mo cap`,
    };
  }
  return { ok: true, remaining };
}
