/**
 * D176 — durable attach blocklist. Once a domain or sender is marked
 * burned, AS(42004) / sender_blocked / restricted, or isolated off a
 * campaign, restaff must not put it back. Protected clients (D174)
 * never retire, so this list is the only durable "stay off" mark.
 */
import { isRetiredSendingDomain } from "./domainControl.js";
import { emailDomainOf } from "./isolationDomain.js";

export type AttachBlockReason =
  | "sender_blocked"
  | "restricted"
  | "burned"
  | "bounce_isolation";

export interface AttachBlockRecord {
  domain: string;
  emails: string[];
  accountIds: number[];
  reason: AttachBlockReason;
  source?: string;
  blockedAt: string;
}

export interface IsolationAskForBlock {
  kind: string;
  status: string;
  detail: Record<string, unknown>;
}

export function normalizeAttachDomain(
  domain: string | undefined,
): string | undefined {
  const trimmed = domain?.trim().toLowerCase().replace(/^@/, "");
  return trimmed || undefined;
}

export function mergeAttachBlock(
  existing: AttachBlockRecord | undefined,
  incoming: {
    domain: string;
    emails?: Iterable<string>;
    accountIds?: Iterable<number>;
    reason: AttachBlockReason;
    source?: string;
    blockedAt?: string;
  },
): AttachBlockRecord {
  const domain = normalizeAttachDomain(incoming.domain);
  if (!domain) {
    throw new Error("attach block requires a domain");
  }
  const emails = new Set<string>(existing?.emails ?? []);
  for (const email of incoming.emails ?? []) {
    const normalized = email.trim().toLowerCase();
    if (normalized.includes("@")) emails.add(normalized);
  }
  const accountIds = new Set<number>(existing?.accountIds ?? []);
  for (const id of incoming.accountIds ?? []) {
    if (Number.isFinite(id)) accountIds.add(id);
  }
  return {
    domain,
    emails: [...emails].sort(),
    accountIds: [...accountIds].sort((a, b) => a - b),
    reason: incoming.reason || existing?.reason || "sender_blocked",
    source: incoming.source ?? existing?.source,
    blockedAt: existing?.blockedAt ?? incoming.blockedAt ?? new Date().toISOString(),
  };
}

/**
 * A live burned-domain / protected-client cover ask is itself a block
 * so a deploy after today's unlink heals on the first restaff pass
 * without waiting for another 5.1.8 sample.
 */
export function isolationAskBlocksDomain(
  domain: string | undefined,
  actions: IsolationAskForBlock[],
): boolean {
  const host = normalizeAttachDomain(domain);
  if (!host) return false;
  return actions.some((action) => {
    const actionDomain = normalizeAttachDomain(
      String(action.detail.domain ?? action.detail.retiredDomain ?? ""),
    );
    if (actionDomain !== host) return false;
    const live =
      action.status === "pending" ||
      action.status === "approved" ||
      action.status === "executed";
    if (!live) return false;
    if (action.kind === "retire_domain") return true;
    if (action.kind === "buy_domains" && Boolean(action.detail.coverOnly)) {
      return true;
    }
    return false;
  });
}

export interface AttachBlockContext {
  blocks?: AttachBlockRecord[];
  domainHistory?: { status?: string };
  isolationActions?: IsolationAskForBlock[];
}

export function isSenderAttachBlocked(
  sender: { email?: string; accountId?: number; domain?: string },
  ctx: AttachBlockContext = {},
): boolean {
  const email = sender.email?.trim().toLowerCase();
  const domain =
    normalizeAttachDomain(sender.domain) ??
    (email ? emailDomainOf(email) : undefined);
  if (isRetiredSendingDomain(domain, ctx.domainHistory)) return true;
  if (isolationAskBlocksDomain(domain, ctx.isolationActions ?? [])) return true;
  for (const block of ctx.blocks ?? []) {
    if (domain && block.domain === domain) return true;
    if (email && block.emails.includes(email)) return true;
    if (
      typeof sender.accountId === "number" &&
      block.accountIds.includes(sender.accountId)
    ) {
      return true;
    }
  }
  return false;
}

export function senderIsAttachBlocked(
  sender: { email?: string; accountId?: number; domain?: string },
  state: {
    listAttachBlocks?: () => AttachBlockRecord[];
    getDomainHistory?: (domain: string) => { status?: string } | undefined;
    listIsolationActions?: () => IsolationAskForBlock[];
  },
): boolean {
  const email = sender.email?.trim().toLowerCase();
  const domain =
    normalizeAttachDomain(sender.domain) ??
    (email ? emailDomainOf(email) : undefined);
  return isSenderAttachBlocked(sender, {
    blocks: state.listAttachBlocks?.() ?? [],
    domainHistory: domain ? state.getDomainHistory?.(domain) : undefined,
    isolationActions: state.listIsolationActions?.() ?? [],
  });
}
