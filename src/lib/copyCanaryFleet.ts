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

/** D60 — already asked, already bought, or waiting on nameservers. */
export function canaryFleetBuyAlreadyOpen(
  fleet: CopyCanaryFleetRecord | null | undefined,
  actions: Array<{
    kind: string;
    status: string;
    detail?: Record<string, unknown>;
  }>,
): boolean {
  if (fleet?.domains.length || fleet?.emails.length) return true;
  if (fleet && fleet.status !== "missing") return true;
  return actions.some(
    (row) =>
      row.kind === "buy_canary_fleet" &&
      (row.status === "pending" ||
        row.status === "approved" ||
        row.status === "executed"),
  );
}

export function domainsFromCanaryBuyActions(
  actions: Array<{
    id?: string;
    kind: string;
    status: string;
    detail?: Record<string, unknown>;
  }>,
): { actionId: string; domains: string[]; emails: string[] } | null {
  const rows = [...actions].reverse();
  for (const row of rows) {
    if (row.kind !== "buy_canary_fleet") continue;
    if (row.status !== "executed" && row.status !== "approved") continue;
    const domains = Array.isArray(row.detail?.domains)
      ? (row.detail!.domains as unknown[])
          .map((value) => String(value).toLowerCase())
          .filter(Boolean)
      : [];
    if (!domains.length) continue;
    const emails = Array.isArray(row.detail?.emails)
      ? (row.detail!.emails as unknown[])
          .map((value) => String(value).toLowerCase())
          .filter(Boolean)
      : [];
    return { actionId: row.id ?? "", domains, emails };
  }
  return null;
}
