/**
 * D213 — permanent Microsoft tenant outbound-block hold.
 *
 * 550 5.1.8 / AS(42004) is not the 5.7.233 / 5.7.705 daily cap. It does
 * not reset at midnight. Every seat on that tenant stays at mpd 0 until
 * a human clears the hold. The 7:15pm D183 restore, mailbox-gap, fan-out,
 * top-up, and min40 skip these seats. This module never writes a daily
 * limit except the 0 used to keep a drifted seat at 0.
 */

export const TENANT_OUTBOUND_BLOCK_MPD = 0;

export { WATCHDOG_SLACK_CHANNEL_ID } from "./deliverabilitySlack.js";

export interface TenantOutboundBlockSeed {
  tenant: string;
  domains: readonly string[];
  accountIds: readonly number[];
}

/**
 * 2026-09-30 — arborbrooksagesunsetxcom.onmicrosoft.com returns
 * 550 5.1.8 / AS(42004) on every send from appquickconnectsales.com.
 * All five seats were already at mpd 0.
 */
export const TENANT_OUTBOUND_BLOCK_SEEDS: readonly TenantOutboundBlockSeed[] = [
  {
    tenant: "arborbrooksagesunsetxcom.onmicrosoft.com",
    domains: ["appquickconnectsales.com"],
    accountIds: [21831478, 21831477, 21831461, 21831401, 21831312],
  },
];

export interface TenantOutboundBlockRecord {
  tenant: string;
  domains: string[];
  accountIds: number[];
  alertedAt: string | null;
  seededAt: string;
}

export interface TenantOutboundBlockStore {
  ensureTenantOutboundBlock(input: {
    tenant?: string;
    domains?: Iterable<string>;
    accountIds?: Iterable<number>;
    now?: Date;
  }): TenantOutboundBlockRecord | undefined;
  isTenantOutboundBlockAccount(accountId: number): boolean;
  isTenantOutboundBlockDomain(domain: string): boolean;
  listTenantOutboundBlocks(): TenantOutboundBlockRecord[];
  listTenantOutboundBlockAccountIds(): number[];
  markTenantOutboundBlockAlerted(tenant: string, now?: Date): void;
  clearTenantOutboundBlock(tenantOrDomain: string): boolean;
}

export function normalizeTenantOutboundHost(value: string): string {
  return value.trim().toLowerCase();
}

export function senderDomainOf(email: string | null | undefined): string | null {
  const host = String(email ?? "")
    .trim()
    .toLowerCase()
    .split("@")[1];
  return host || null;
}

export function accountOnTenantOutboundHold(
  account: {
    id?: number | null;
    from_email?: string | null;
    email?: string | null;
  },
  store?: Pick<
    TenantOutboundBlockStore,
    "isTenantOutboundBlockAccount" | "isTenantOutboundBlockDomain"
  > | null,
): boolean {
  if (!store) return false;
  const id = Number(account.id);
  if (Number.isFinite(id) && id > 0 && store.isTenantOutboundBlockAccount(id)) {
    return true;
  }
  const domain = senderDomainOf(account.from_email ?? account.email);
  return Boolean(domain && store.isTenantOutboundBlockDomain(domain));
}

export function tenantOutboundBlockAlertText(block: {
  tenant: string;
  domains: string[];
  accountIds: number[];
}): string {
  const domains = block.domains.length
    ? block.domains.join(", ")
    : "(domain unknown)";
  const ids = block.accountIds.length
    ? block.accountIds.join(", ")
    : "(no account ids yet)";
  return [
    `*Microsoft tenant outbound block — needs delist or replacement.*`,
    `Tenant \`${block.tenant}\` is returning 550 5.1.8 / AS(42004) on every send.`,
    `Sending domain: ${domains}.`,
    `Held at 0 with no automatic restore: ${ids}.`,
    `This is not the 5.7.705 / 5.7.233 tenant cap. It will not clear overnight. A human has to delist the tenant or replace these seats.`,
  ].join("\n");
}

export function healTenantOutboundBlockSeeds(
  store: Pick<TenantOutboundBlockStore, "ensureTenantOutboundBlock" | "listTenantOutboundBlockAccountIds">,
  now = new Date(),
): { wrote: boolean; accountIds: number[] } {
  const before = new Set(store.listTenantOutboundBlockAccountIds());
  const accountIds: number[] = [];
  for (const seed of TENANT_OUTBOUND_BLOCK_SEEDS) {
    store.ensureTenantOutboundBlock({
      tenant: seed.tenant,
      domains: seed.domains,
      accountIds: seed.accountIds,
      now,
    });
    accountIds.push(...seed.accountIds);
  }
  const after = store.listTenantOutboundBlockAccountIds();
  const wrote = after.some((id) => !before.has(id));
  return { wrote, accountIds: [...new Set(accountIds)] };
}

export async function maybeNotifyTenantOutboundBlock(input: {
  store: TenantOutboundBlockStore;
  slack: {
    notifyWatchdogTenantBlock(text: string): Promise<unknown>;
  };
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  let posted = false;
  for (const block of input.store.listTenantOutboundBlocks()) {
    if (block.alertedAt) continue;
    await input.slack.notifyWatchdogTenantBlock(
      tenantOutboundBlockAlertText(block),
    );
    input.store.markTenantOutboundBlockAlerted(block.tenant, now);
    posted = true;
  }
  return posted;
}
