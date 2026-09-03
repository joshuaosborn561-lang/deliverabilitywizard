/**
 * D174 — a configurable list of clients whose sending domains must
 * never be retired or burned. Seeded with Goliath / Smartlead 548611.
 * A protected domain degrades to buy/cover replacements; the Slack
 * post says why a retire is not on offer. Execution refuses even an
 * already-open pending retire tap.
 */
import type { DomainOwnerRecord } from "./domainOwnership.js";

export const DEFAULT_PROTECTED_CLIENT_IDS = [548611] as const;
export const DEFAULT_PROTECTED_CLIENT_NAMES = ["goliath"] as const;

export type ProtectedClientConfig = {
  protectedClientIds: number[];
  protectedClientNames: string[];
};

export function parseIdList(raw: string | undefined, fallback: readonly number[]): number[] {
  if (raw == null || raw.trim() === "") return [...fallback];
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
  return parsed.length ? parsed : [...fallback];
}

export function parseNameList(
  raw: string | undefined,
  fallback: readonly string[],
): string[] {
  if (raw == null || raw.trim() === "") return [...fallback];
  const parsed = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length ? parsed : [...fallback];
}

export function isProtectedClientId(
  clientId: number | null | undefined,
  config: Pick<ProtectedClientConfig, "protectedClientIds">,
): boolean {
  if (typeof clientId !== "number" || !Number.isFinite(clientId)) return false;
  return config.protectedClientIds.includes(clientId);
}

export function isProtectedClientName(
  hay: string | null | undefined,
  config: Pick<ProtectedClientConfig, "protectedClientNames">,
): boolean {
  const text = String(hay ?? "").toLowerCase();
  if (!text) return false;
  return config.protectedClientNames.some(
    (needle) => needle.length > 0 && text.includes(needle),
  );
}

export function isProtectedClient(
  client: {
    id?: number | null;
    name?: string | null;
    logo?: string | null;
  } | null | undefined,
  config: ProtectedClientConfig,
): boolean {
  if (!client) return false;
  if (isProtectedClientId(client.id, config)) return true;
  return isProtectedClientName(
    `${client.name ?? ""} ${client.logo ?? ""}`,
    config,
  );
}

export function isProtectedOwner(
  owner: DomainOwnerRecord | null | undefined,
  config: ProtectedClientConfig,
): boolean {
  if (!owner || owner.kind !== "client") return false;
  if (isProtectedClientId(owner.clientId, config)) return true;
  return isProtectedClientName(owner.clientName, config);
}

export function protectedRetireReason(
  owner: DomainOwnerRecord | null | undefined,
  domain: string,
): string {
  const who =
    owner?.clientName && owner.clientId
      ? `${owner.clientName} (client ${owner.clientId})`
      : owner?.clientName
        ? owner.clientName
        : owner?.clientId
          ? `client ${owner.clientId}`
          : "a protected client";
  return (
    `Not offering a retire for ${domain}: it is ${who} inventory. ` +
    `Protected clients never have a domain retired or burned (D174). ` +
    `Buying cover replacements instead.`
  );
}
