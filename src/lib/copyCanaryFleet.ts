/**
 * D54 — dedicated unwarmed campaign-copy canary fleet.
 *
 * Not the D51 warming-pool slice. Two new domains, three inboxes each,
 * one Google and one Outlook. Warmup stays off. They send live campaign
 * copy. They are not staffable supply.
 */

export const COPY_CANARY_FLEET_DOMAIN_COUNT = 2;
export const COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN = 3;

export const COPY_CANARY_FLEET_SIZE =
  COPY_CANARY_FLEET_DOMAIN_COUNT * COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN;

export type CopyCanaryFleetStatus =
  | "missing"
  | "pending"
  | "buying"
  | "awaiting_mailboxes"
  | "awaiting_export"
  | "ready";

export interface CopyCanaryFleetRecord {
  status: CopyCanaryFleetStatus;
  googleDomain?: string;
  microsoftDomain?: string;
  domains: string[];
  emails: string[];
  actionId?: string;
  updatedAt: string;
}

export function emptyCopyCanaryFleet(
  now = new Date().toISOString(),
): CopyCanaryFleetRecord {
  return {
    status: "missing",
    domains: [],
    emails: [],
    updatedAt: now,
  };
}

export function platformForCanaryDomainIndex(
  index: number,
): "GOOGLE" | "MICROSOFT" {
  return index === 0 ? "GOOGLE" : "MICROSOFT";
}

export function isCopyCanaryFleetEmail(
  email: string,
  fleet: CopyCanaryFleetRecord | null | undefined,
): boolean {
  if (!fleet) return false;
  const lower = email.toLowerCase();
  if (fleet.emails.some((row) => row.toLowerCase() === lower)) return true;
  const domain = lower.split("@")[1] ?? "";
  return Boolean(domain) && isCopyCanaryFleetDomain(domain, fleet);
}

export function isCopyCanaryFleetDomain(
  domain: string,
  fleet: CopyCanaryFleetRecord | null | undefined,
): boolean {
  if (!fleet) return false;
  const lower = domain.toLowerCase();
  return fleet.domains.some((row) => row.toLowerCase() === lower);
}
