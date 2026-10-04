/**
 * D219 — mailbox send type from domain / existing type:* tag / Smartlead
 * ESP family. Caps: Azure/Entra 2 campaign + 5 warmup; Microsoft 365 15
 * campaign (warmup unchanged); Google unchanged.
 *
 * tidalstackco.com is Azure/Entra. The Deliverability agent already tagged
 * the fleet type:google / type:m365 / type:azure; this module is how the
 * wizard decides the same way and converges missing tags.
 */

import { normalizeSenderEspFamily } from "./esp.js";

export type MailboxSendType = "google" | "m365" | "azure";

export const TYPE_TAG = {
  google: "type:google",
  m365: "type:m365",
  azure: "type:azure",
} as const;

export const MAILBOX_TYPE_TAGS = [
  TYPE_TAG.google,
  TYPE_TAG.m365,
  TYPE_TAG.azure,
] as const;

/** Known Azure / Entra sending domains. tidalstackco.com is the locked one. */
export const AZURE_ENTRA_DOMAINS = new Set(["tidalstackco.com"]);

export const AZURE_CAMPAIGN_PER_DAY = 2;
export const AZURE_WARMUP_PER_DAY = 5;
export const M365_CAMPAIGN_PER_DAY = 15;

/**
 * D232 — Azure/Entra (type:azure / tidalstackco.com) counts as 0.1
 * of a regular mailbox toward a POD's 40. Every other type is 1.
 */
export const AZURE_STAFFABLE_WEIGHT = 0.1;
export const REGULAR_STAFFABLE_WEIGHT = 1;
export const STAFFABLE_WEIGHT_EPS = 1e-9;

export function roundStaffableWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

export function mailboxStaffableWeight(account: {
  type?: string | null;
  platform?: string | null;
  from_email?: string | null;
  email?: string | null;
  tags?: Array<{ tag_name?: string; name?: string }>;
} | null | undefined): number {
  return classifyMailboxSendType(account) === "azure"
    ? AZURE_STAFFABLE_WEIGHT
    : REGULAR_STAFFABLE_WEIGHT;
}

export function weightedStaffableShortfall(
  weighted: number,
  floor: number = 40,
): number {
  return roundStaffableWeight(Math.max(0, floor - (Number.isFinite(weighted) ? weighted : 0)));
}

export function senderHostOf(
  email: string | null | undefined,
): string | null {
  const host = String(email ?? "")
    .trim()
    .toLowerCase()
    .split("@")[1];
  return host || null;
}

export function tagNamesOf(
  account: { tags?: Array<{ tag_name?: string; name?: string }> } | null | undefined,
): string[] {
  return (account?.tags ?? [])
    .map((tag) => String(tag.tag_name ?? tag.name ?? "").trim())
    .filter(Boolean);
}

export function mailboxTypeFromTags(tags: readonly string[]): MailboxSendType | null {
  const lower = tags.map((tag) => tag.trim().toLowerCase());
  if (lower.includes(TYPE_TAG.azure)) return "azure";
  if (lower.includes(TYPE_TAG.m365)) return "m365";
  if (lower.includes(TYPE_TAG.google)) return "google";
  return null;
}

export function isAzureEntraDomain(domain: string | null | undefined): boolean {
  const host = String(domain ?? "")
    .trim()
    .toLowerCase();
  return Boolean(host) && AZURE_ENTRA_DOMAINS.has(host);
}

/**
 * Desired type for tagging + caps. Tag wins (agent already labelled the
 * fleet). Azure domain wins over a raw Outlook type. Microsoft family
 * without an Azure mark is M365. Google family is Google.
 */
export function classifyMailboxSendType(account: {
  type?: string | null;
  platform?: string | null;
  from_email?: string | null;
  email?: string | null;
  tags?: Array<{ tag_name?: string; name?: string }>;
} | null | undefined): MailboxSendType | null {
  if (!account) return null;
  const tagged = mailboxTypeFromTags(tagNamesOf(account));
  if (tagged) return tagged;
  const host = senderHostOf(account.from_email ?? account.email);
  if (isAzureEntraDomain(host)) return "azure";
  const family = normalizeSenderEspFamily(account.type ?? account.platform);
  if (family === "microsoft") return "m365";
  if (family === "google") return "google";
  return null;
}

export function typeTagFor(type: MailboxSendType): string {
  return TYPE_TAG[type];
}

export function mailboxTypeCampaignCap(
  account: {
    type?: string | null;
    platform?: string | null;
    from_email?: string | null;
    email?: string | null;
    tags?: Array<{ tag_name?: string; name?: string }>;
  } | null | undefined,
  config: { messagePerDay: number },
): number {
  const kind = classifyMailboxSendType(account);
  if (kind === "azure") return AZURE_CAMPAIGN_PER_DAY;
  if (kind === "m365") return M365_CAMPAIGN_PER_DAY;
  return config.messagePerDay;
}

export function mailboxTypeWarmupCap(
  account: {
    type?: string | null;
    platform?: string | null;
    from_email?: string | null;
    email?: string | null;
    tags?: Array<{ tag_name?: string; name?: string }>;
  } | null | undefined,
  config: { warmupTotalPerDay: number },
): number {
  const kind = classifyMailboxSendType(account);
  if (kind === "azure") return AZURE_WARMUP_PER_DAY;
  return config.warmupTotalPerDay;
}
