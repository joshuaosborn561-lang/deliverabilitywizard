/**
 * D219 — Microsoft 550 5.7.233 (TERRL) tenant hold.
 *
 * On a 5.7.233 from a tenant: every seat on that tenant goes to
 * max_email_per_day=0 for 24 hours (rolling) but stays linked with its
 * POD tag unchanged. After the window the seat resumes its normal type
 * cap (Azure 2, M365 15, Google unchanged). No learned send limit. No
 * 80% cap. A same-client warm generic may temporarily link on the
 * on-week campaign so the POD stays at 40 sending (41 linked). Slack
 * is one weekday EOD digest, never per bounce.
 */

import { senderHostOf } from "./mailboxType.js";

export const TERL_HOLD_MS = 24 * 60 * 60 * 1000;

export interface TenantTerlHoldRecord {
  tenant: string;
  domains: string[];
  accountIds: number[];
  heldUntil: string;
  firstHeldAt: string;
}

export interface TerlPausedInbox {
  accountId: number;
  email: string;
  clientId: number | null;
  clientName: string;
  tenant: string;
  pausedAt: string;
}

export interface TerlPausedDay {
  ymd: string;
  postedAt: string | null;
  inboxes: TerlPausedInbox[];
}

export interface TerlSubstitution {
  stoppedAccountId: number;
  stoppedEmail: string;
  substituteAccountId: number | null;
  substituteEmail: string | null;
  campaignId: number;
  campaignName: string;
  clientId: number;
  clientName: string;
  tenant: string;
  stoppedAt: string;
  restoreAfter: string;
  restoredAt: string | null;
  noSubstitute: boolean;
}

export interface TerlEodShortage {
  campaignId: number;
  campaignName: string;
  clientId: number | null;
  clientName: string;
  sending: number;
}

export interface TenantTerlHoldStore {
  ensureTenantTerlHold(input: {
    tenant?: string;
    domains?: Iterable<string>;
    accountIds?: Iterable<number>;
    now?: Date;
  }): TenantTerlHoldRecord | undefined;
  getTenantTerlHold(tenantOrDomain: string): TenantTerlHoldRecord | undefined;
  listTenantTerlHolds(): TenantTerlHoldRecord[];
  isTenantTerlHoldAccount(accountId: number, now?: Date): boolean;
  isTenantTerlHoldDomain(domain: string, now?: Date): boolean;
  recordTerlPausedInboxes(input: {
    ymd: string;
    inboxes: Iterable<TerlPausedInbox>;
  }): void;
  listTerlPausedInboxes(ymd: string): TerlPausedInbox[];
  terlEodPosted(ymd: string): boolean;
  markTerlEodPosted(ymd: string, now?: Date): void;
  upsertTerlSubstitution(row: TerlSubstitution): void;
  listTerlSubstitutions(): TerlSubstitution[];
  listOpenTerlSubstitutions(now?: Date): TerlSubstitution[];
  markTerlSubstitutionRestored(key: string, now?: Date): void;
}

export function terlSubstitutionKey(
  campaignId: number,
  stoppedAccountId: number,
): string {
  return `${campaignId}:${stoppedAccountId}`;
}

export function normalizeTerlHost(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function terlHeldUntil(now: Date): Date {
  return new Date(now.getTime() + TERL_HOLD_MS);
}

export function terlHoldActive(
  heldUntil: string | null | undefined,
  now: Date,
): boolean {
  if (!heldUntil) return false;
  const at = Date.parse(heldUntil);
  return Number.isFinite(at) && now.getTime() < at;
}

export function accountOnTenantTerlHold(
  account: {
    id?: number | null;
    from_email?: string | null;
    email?: string | null;
  },
  store?: Pick<
    TenantTerlHoldStore,
    "isTenantTerlHoldAccount" | "isTenantTerlHoldDomain"
  > | null,
  now = new Date(),
): boolean {
  if (!store) return false;
  const id = Number(account.id);
  if (Number.isFinite(id) && id > 0 && store.isTenantTerlHoldAccount(id, now)) {
    return true;
  }
  const host = senderHostOf(account.from_email ?? account.email);
  return host ? store.isTenantTerlHoldDomain(host, now) : false;
}

export function terlEodDigestText(input: {
  inboxes: readonly TerlPausedInbox[];
  shortages?: readonly TerlEodShortage[];
}): string | null {
  const inboxes = input.inboxes;
  const shortages = input.shortages ?? [];
  if (!inboxes.length && !shortages.length) return null;
  const byClient = new Map<
    string,
    { inboxes: TerlPausedInbox[]; shortages: TerlEodShortage[] }
  >();
  const clientKey = (name: string, id: number | null): string =>
    name.trim() || (id != null ? `Client ${id}` : "Unknown client");
  for (const row of inboxes) {
    const key = clientKey(row.clientName, row.clientId);
    const bucket = byClient.get(key) ?? { inboxes: [], shortages: [] };
    bucket.inboxes.push(row);
    byClient.set(key, bucket);
  }
  for (const row of shortages) {
    const key = clientKey(row.clientName, row.clientId);
    const bucket = byClient.get(key) ?? { inboxes: [], shortages: [] };
    bucket.shortages.push(row);
    byClient.set(key, bucket);
  }
  const lines = ["*Microsoft 550 5.7.233 holds today*"];
  for (const client of [...byClient.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push("");
    lines.push(`*${client}*`);
    const bucket = byClient.get(client)!;
    const seen = new Set<string>();
    for (const row of bucket.inboxes
      .slice()
      .sort((a, b) => a.email.localeCompare(b.email))) {
      const email = row.email.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      lines.push(`• ${email} (${row.tenant})`);
    }
    for (const row of bucket.shortages
      .slice()
      .sort((a, b) => a.campaignId - b.campaignId)) {
      const name = row.campaignName.trim() || `#${row.campaignId}`;
      lines.push(
        `• #${row.campaignId} ${name}: no substitute available, at ${row.sending} sending`,
      );
    }
  }
  return lines.join("\n");
}
