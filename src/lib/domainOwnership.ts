/**
 * D173 — a sending domain's owner is who staffs it, not the generic
 * pool plan. Plan membership is the fallback when mailboxes do not
 * name a real Smartlead client. A plan-listed domain whose live
 * mailboxes all belong to one real client is that client's domain
 * for retire eligibility, replacement naming, and generic-cover.
 */
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import type { SmartleadClientRecord } from "../clients/smartlead.js";
import { clientDisplayName } from "../clients/smartlead.js";
import { isGenericPoolDomain } from "./clientInbox.js";

type AccountHostFields = Pick<
  SmartleadAccountWithCampaigns,
  "from_email" | "email" | "username" | "client_id"
>;

function accountHost(account: AccountHostFields): string {
  const email = String(
    account.from_email ?? account.email ?? account.username ?? "",
  )
    .trim()
    .toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1);
}

export type DomainOwnerConfig = {
  extraGenericDomains: string[];
  prewarmedDomains: string[];
};

export type DomainOwnerKind = "client" | "generic" | "unknown";

export interface DomainOwnerRecord {
  domain: string;
  kind: DomainOwnerKind;
  clientId: number | null;
  clientName: string | null;
  mailboxCount: number;
  uniqueClientIds: number[];
  planSaysGeneric: boolean;
  conflict: boolean;
  source: "mailboxes" | "plan" | "cache";
  updatedAt: string;
}

export function planSaysGenericDomain(
  domain: string,
  config: DomainOwnerConfig,
): boolean {
  const host = domain.trim().toLowerCase();
  if (!host) return false;
  if (isGenericPoolDomain(host)) return true;
  if (config.extraGenericDomains.includes(host)) return true;
  if (config.prewarmedDomains.includes(host)) return true;
  return false;
}

function isRealClientId(
  id: number | null | undefined,
  isMarkerClientId?: (id: number) => boolean,
): id is number {
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return false;
  if (isMarkerClientId?.(id)) return false;
  return true;
}

/**
 * Live mailbox client_ids win. The static pool plan is the fallback
 * when no real client staffs the domain. Split real clients stay
 * unknown (never guessed). A plan-vs-mailbox conflict is flagged
 * and logged — the mailboxes still win.
 */
export function resolveDomainOwner(
  domain: string,
  accounts: Array<
    Pick<SmartleadAccountWithCampaigns, "from_email" | "email" | "username" | "client_id">
  >,
  clients: SmartleadClientRecord[],
  config: DomainOwnerConfig,
  opts?: {
    isMarkerClientId?: (id: number) => boolean;
    now?: string;
  },
): DomainOwnerRecord {
  const host = domain.trim().toLowerCase();
  const now = opts?.now ?? new Date().toISOString();
  const onDomain = accounts.filter((account) => accountHost(account) === host);
  const unique = new Set<number>();
  for (const account of onDomain) {
    if (isRealClientId(account.client_id, opts?.isMarkerClientId)) {
      unique.add(account.client_id);
    }
  }
  const uniqueClientIds = [...unique];
  const planGeneric =
    isGenericPoolDomain(host) || planSaysGenericDomain(host, config);
  const clientsById = new Map(clients.map((client) => [client.id, client]));

  if (uniqueClientIds.length === 1) {
    const clientId = uniqueClientIds[0]!;
    const clientName = clientDisplayName(
      clientsById.get(clientId) ?? { id: clientId },
    );
    const conflict = planGeneric;
    if (conflict) {
      console.warn(
        `[domain-owner] ${host} is on the generic pool plan but live mailboxes belong to client ${clientId} (${clientName}) — treating as client-owned (D173)`,
      );
    }
    return {
      domain: host,
      kind: "client",
      clientId,
      clientName,
      mailboxCount: onDomain.length,
      uniqueClientIds,
      planSaysGeneric: planGeneric,
      conflict,
      source: "mailboxes",
      updatedAt: now,
    };
  }

  if (uniqueClientIds.length > 1) {
    console.warn(
      `[domain-owner] ${host} has split real client_ids ${uniqueClientIds.join(",")} — not treating as a single client's domain (D173)`,
    );
    return {
      domain: host,
      kind: "unknown",
      clientId: null,
      clientName: null,
      mailboxCount: onDomain.length,
      uniqueClientIds,
      planSaysGeneric: planGeneric,
      conflict: planGeneric,
      source: "mailboxes",
      updatedAt: now,
    };
  }

  return {
    domain: host,
    kind: planGeneric ? "generic" : "unknown",
    clientId: null,
    clientName: null,
    mailboxCount: onDomain.length,
    uniqueClientIds,
    planSaysGeneric: planGeneric,
    conflict: false,
    source: onDomain.length ? "mailboxes" : "plan",
    updatedAt: now,
  };
}

export function buildDomainOwnerCache(
  accounts: Array<
    Pick<SmartleadAccountWithCampaigns, "from_email" | "email" | "username" | "client_id">
  >,
  clients: SmartleadClientRecord[],
  config: DomainOwnerConfig,
  opts?: {
    isMarkerClientId?: (id: number) => boolean;
    now?: string;
  },
): Record<string, DomainOwnerRecord> {
  const domains = new Set<string>();
  for (const account of accounts) {
    const host = accountHost(account);
    if (host) domains.add(host);
  }
  const out: Record<string, DomainOwnerRecord> = {};
  for (const domain of domains) {
    out[domain] = resolveDomainOwner(domain, accounts, clients, config, opts);
  }
  return out;
}

export function ownerFromCache(
  cache: Record<string, DomainOwnerRecord> | undefined,
  domain: string,
): DomainOwnerRecord | undefined {
  if (!cache) return undefined;
  return cache[domain.trim().toLowerCase()];
}
