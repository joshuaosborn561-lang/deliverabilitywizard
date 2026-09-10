import {
  accountDomain,
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { BounceVerdictRecord, SendCeilingHoldRecord } from "../state/store.js";
import { isInsightCampaignId } from "./insightCampaigns.js";
import { readMessagePerDay } from "./mailboxSendSettings.js";
import {
  isOutlookMailboxType,
  mailboxMessagePerDayTarget,
} from "./sendCeiling.js";
import type { AppConfig } from "../config.js";

/**
 * D191 — a tenant_rate_limit incident holds Outlook / Microsoft senders
 * at 0/day so the 15-minute D183 converge cannot keep re-arming the
 * exhausted Microsoft tenant. Restore 15 minutes after the next UTC
 * midnight (Microsoft's cap reset; ~7:15pm CT).
 */
export const TENANT_CEILING_HOLD_TARGET = 0;
export const TENANT_CEILING_RESTORE_GRACE_MIN = 15;
/** Host labels must share this many leading chars to count as one family. */
export const TENANT_DOMAIN_FAMILY_PREFIX_MIN = 8;

export interface SendCeilingHoldStore {
  listBounceVerdicts(): BounceVerdictRecord[];
  getSendCeilingHold(accountId: number): SendCeilingHoldRecord | undefined;
  setSendCeilingHold(record: SendCeilingHoldRecord): void;
  clearSendCeilingHold(accountId: number): void;
  listSendCeilingHolds(): SendCeilingHoldRecord[];
}

export function tenantCeilingRestoreAt(
  fromIso: string,
  nowMs: number = Date.now(),
): string {
  const from = Date.parse(fromIso);
  const d = new Date(Number.isFinite(from) ? from : nowMs);
  const sameDayGrace = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    0,
    TENANT_CEILING_RESTORE_GRACE_MIN,
    0,
    0,
  );
  if (d.getTime() < sameDayGrace) {
    return new Date(sameDayGrace).toISOString();
  }
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    TENANT_CEILING_RESTORE_GRACE_MIN,
    0,
    0,
  );
  return new Date(next).toISOString();
}

export function sendCeilingHoldActive(
  hold: Pick<SendCeilingHoldRecord, "restoreAt"> | undefined,
  nowMs: number,
): boolean {
  if (!hold) return false;
  const at = Date.parse(hold.restoreAt);
  return Number.isFinite(at) && at > nowMs;
}

export function effectiveMailboxMessagePerDay(
  standing: number,
  hold: SendCeilingHoldRecord | undefined,
  nowMs: number,
): number {
  if (sendCeilingHoldActive(hold, nowMs)) return hold!.maxEmailPerDay;
  return standing;
}

export function mailboxSendCeilingNow(
  account: {
    id?: number;
    type?: string | null;
    platform?: string | null;
  } | null | undefined,
  config: Pick<AppConfig, "messagePerDay">,
  store: Pick<SendCeilingHoldStore, "getSendCeilingHold"> | undefined,
  nowMs: number,
): number {
  const standing = mailboxMessagePerDayTarget(account, config);
  const id = account?.id;
  const hold =
    typeof id === "number" && Number.isFinite(id)
      ? store?.getSendCeilingHold(id)
      : undefined;
  return effectiveMailboxMessagePerDay(standing, hold, nowMs);
}

export function hostLabel(domain: string): string {
  return domain.trim().toLowerCase().split(".")[0] ?? "";
}

export function domainsShareBrandPrefix(a: string, b: string): boolean {
  const ha = hostLabel(a);
  const hb = hostLabel(b);
  if (!ha || !hb) return false;
  const n = Math.min(ha.length, hb.length);
  let i = 0;
  while (i < n && ha[i] === hb[i]) i += 1;
  return i >= TENANT_DOMAIN_FAMILY_PREFIX_MIN;
}

export function tenantRateLimitHoldOpen(
  verdict: BounceVerdictRecord,
  nowMs: number,
): boolean {
  if (verdict.dominant !== "tenant_rate_limit") return false;
  return Date.parse(tenantCeilingRestoreAt(verdict.at, nowMs)) > nowMs;
}

/**
 * Outlook / Microsoft seats that share the exhausted tenant: the
 * bursting campaign, other Insight lanes when the burst is Insight,
 * sender-domain family (salesglidergo ↔ salesgliderops), and Outlook
 * already at 0 so a hand-zero is not raised before we record the hold.
 */
export function accountMatchesTenantRateLimitHold(
  account: SmartleadAccountWithCampaigns,
  verdict: BounceVerdictRecord,
  currentPerDay?: number,
): boolean {
  if (!isOutlookMailboxType(account.type ?? account.platform)) return false;
  const cids = campaignIdsOf(account);
  if (cids.includes(verdict.campaignId)) return true;
  if (
    isInsightCampaignId(verdict.campaignId) &&
    cids.some((id) => isInsightCampaignId(id))
  ) {
    return true;
  }
  const domain = accountDomain(account);
  const senders = verdict.senderDomains.map((d) => d.trim().toLowerCase());
  if (domain && senders.includes(domain)) return true;
  if (domain && senders.some((d) => domainsShareBrandPrefix(d, domain))) {
    return true;
  }
  if (currentPerDay === TENANT_CEILING_HOLD_TARGET) return true;
  return false;
}

export function syncTenantRateLimitSendCeilingHolds(args: {
  store: SendCeilingHoldStore;
  accounts: SmartleadAccountWithCampaigns[];
  nowMs: number;
}): { held: number; expired: number } {
  const { store, accounts, nowMs } = args;
  let expired = 0;
  for (const hold of store.listSendCeilingHolds()) {
    if (sendCeilingHoldActive(hold, nowMs)) continue;
    store.clearSendCeilingHold(hold.accountId);
    expired += 1;
  }

  const open = store.listBounceVerdicts().filter((v) =>
    tenantRateLimitHoldOpen(v, nowMs),
  );
  let held = 0;
  if (!open.length) return { held, expired };

  for (const account of accounts) {
    if (!account.id) continue;
    const email = accountEmail(account);
    if (!email) continue;
    const current = readMessagePerDay(account);
    const verdict = open.find((v) =>
      accountMatchesTenantRateLimitHold(
        account,
        v,
        Number.isFinite(current) ? current : undefined,
      ),
    );
    if (!verdict) continue;
    const restoreAt = tenantCeilingRestoreAt(verdict.at, nowMs);
    const existing = store.getSendCeilingHold(account.id);
    store.setSendCeilingHold({
      accountId: account.id,
      email: email.toLowerCase(),
      maxEmailPerDay: TENANT_CEILING_HOLD_TARGET,
      restoreAt,
      reason: "tenant_rate_limit",
      campaignId: verdict.campaignId,
      domains: [...verdict.senderDomains],
      heldAt: existing?.heldAt ?? new Date(nowMs).toISOString(),
    });
    held += 1;
  }
  return { held, expired };
}
