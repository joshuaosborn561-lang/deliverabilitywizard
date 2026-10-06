/**
 * D54 / D240 — dedicated unwarmed campaign-copy canary fleet.
 *
 * Not the D51 warming-pool slice. The living fleet is adopted from the
 * Smartlead `CANARY` tag and/or `CANARY_FLEET_EMAILS`. Size is 10
 * (5 Google + 5 M365 on 4 domains after the 2026-10-05 swap). Minimum
 * usable posture is still one Google domain + one Outlook domain.
 * Warmup stays off. They send live campaign copy. They are not
 * staffable supply.
 *
 * The 2026-10-05 contaminated 6-seat fleet (getcrosslaunchco.info /
 * crosslaunchcoget.info) is on the released list and is never
 * re-adopted or rebuilt from the original purchase.
 */

export const COPY_CANARY_FLEET_SIZE = 10;
export const COPY_CANARY_FLEET_MIN_GOOGLE_DOMAINS = 1;
export const COPY_CANARY_FLEET_MIN_MICROSOFT_DOMAINS = 1;

/** Porkbun buy SKU (Josh-tapped). Adopt/registry is not this shape. */
export const COPY_CANARY_FLEET_DOMAIN_COUNT = 2;
export const COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN = 3;

export const CONTAMINATED_CANARY_LOCAL_PARTS = [
  "leilasanchez",
  "kwamelopez",
  "aminarodriguez",
  "marcusrossi",
  "jasminecosta",
  "ninajefferson",
] as const;

export const CONTAMINATED_CANARY_DOMAINS = [
  "getcrosslaunchco.info",
  "crosslaunchcoget.info",
] as const;

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
  source?: "tag" | "env" | "buy" | "manual";
  updatedAt: string;
}

export interface ReleasedCanaryFleetRecord {
  emails: string[];
  domains: string[];
  releasedAt: string;
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

export function emptyReleasedCanaryFleet(
  now = new Date().toISOString(),
): ReleasedCanaryFleetRecord {
  return {
    emails: defaultReleasedCanaryEmails(),
    domains: [...CONTAMINATED_CANARY_DOMAINS],
    releasedAt: now,
  };
}

export function defaultReleasedCanaryEmails(): string[] {
  const out: string[] = [];
  for (const local of CONTAMINATED_CANARY_LOCAL_PARTS) {
    for (const domain of CONTAMINATED_CANARY_DOMAINS) {
      out.push(`${local}@${domain}`);
    }
  }
  return out;
}

export function mergeReleasedCanaryFleet(
  ...parts: Array<Partial<ReleasedCanaryFleetRecord> | null | undefined>
): ReleasedCanaryFleetRecord {
  const emails = new Set(defaultReleasedCanaryEmails());
  const domains = new Set<string>(CONTAMINATED_CANARY_DOMAINS);
  let releasedAt = "";
  for (const part of parts) {
    for (const email of part?.emails ?? []) {
      const key = String(email).trim().toLowerCase();
      if (key.includes("@")) emails.add(key);
    }
    for (const domain of part?.domains ?? []) {
      const key = String(domain).trim().toLowerCase();
      if (key) domains.add(key);
    }
    if (part?.releasedAt && part.releasedAt > releasedAt) {
      releasedAt = part.releasedAt;
    }
  }
  return {
    emails: [...emails],
    domains: [...domains],
    releasedAt: releasedAt || new Date().toISOString(),
  };
}

export function isReleasedCanaryDomain(
  domain: string,
  extra?: ReleasedCanaryFleetRecord | null,
): boolean {
  const key = domain.trim().toLowerCase();
  if (!key) return false;
  if ((CONTAMINATED_CANARY_DOMAINS as readonly string[]).includes(key)) {
    return true;
  }
  return Boolean(
    extra?.domains.some((row) => row.toLowerCase() === key),
  );
}

export function isReleasedCanaryEmail(
  email: string,
  extra?: ReleasedCanaryFleetRecord | null,
): boolean {
  const key = email.trim().toLowerCase();
  if (!key.includes("@")) return false;
  const domain = key.split("@")[1] ?? "";
  if (isReleasedCanaryDomain(domain, extra)) return true;
  if (extra?.emails.some((row) => row.toLowerCase() === key)) return true;
  return false;
}

export function platformForCanaryDomainIndex(
  index: number,
): "GOOGLE" | "MICROSOFT" {
  return index === 0 ? "GOOGLE" : "MICROSOFT";
}

export function isCopyCanaryFleetEmail(
  email: string,
  fleet: CopyCanaryFleetRecord | null | undefined,
  released?: ReleasedCanaryFleetRecord | null,
): boolean {
  if (!fleet) return false;
  const lower = email.toLowerCase();
  if (isReleasedCanaryEmail(lower, released)) return false;
  if (fleet.emails.some((row) => row.toLowerCase() === lower)) return true;
  const domain = lower.split("@")[1] ?? "";
  return Boolean(domain) && isCopyCanaryFleetDomain(domain, fleet, released);
}

export function isCopyCanaryFleetDomain(
  domain: string,
  fleet: CopyCanaryFleetRecord | null | undefined,
  released?: ReleasedCanaryFleetRecord | null,
): boolean {
  if (!fleet) return false;
  const lower = domain.toLowerCase();
  if (isReleasedCanaryDomain(lower, released)) return false;
  return fleet.domains.some((row) => row.toLowerCase() === lower);
}

export function sanitizeCopyCanaryFleet(
  fleet: CopyCanaryFleetRecord | null | undefined,
  released?: ReleasedCanaryFleetRecord | null,
): CopyCanaryFleetRecord | null {
  if (!fleet) return null;
  const emails = fleet.emails.filter(
    (email) => !isReleasedCanaryEmail(email, released),
  );
  const domains = fleet.domains.filter(
    (domain) => !isReleasedCanaryDomain(domain, released),
  );
  const googleDomain =
    fleet.googleDomain &&
    !isReleasedCanaryDomain(fleet.googleDomain, released)
      ? fleet.googleDomain
      : domains[0];
  const microsoftDomain =
    fleet.microsoftDomain &&
    !isReleasedCanaryDomain(fleet.microsoftDomain, released)
      ? fleet.microsoftDomain
      : domains.find((row) => row !== googleDomain);
  if (!emails.length && !domains.length) {
    return {
      ...emptyCopyCanaryFleet(fleet.updatedAt),
      actionId: fleet.actionId,
    };
  }
  return {
    ...fleet,
    emails,
    domains,
    googleDomain,
    microsoftDomain,
    status:
      emails.length && fleetMeetsEspMinimum({ ...fleet, emails, domains, googleDomain, microsoftDomain })
        ? fleet.status === "missing"
          ? "awaiting_export"
          : fleet.status
        : fleet.status === "ready"
          ? "awaiting_export"
          : fleet.status,
  };
}

export function fleetMeetsEspMinimum(
  fleet: Pick<
    CopyCanaryFleetRecord,
    "googleDomain" | "microsoftDomain" | "domains"
  > & {
    googleDomains?: string[];
    microsoftDomains?: string[];
  },
): boolean {
  const google =
    fleet.googleDomains?.filter(Boolean).length ??
    (fleet.googleDomain ? 1 : 0);
  const microsoft =
    fleet.microsoftDomains?.filter(Boolean).length ??
    (fleet.microsoftDomain ? 1 : 0);
  return (
    google >= COPY_CANARY_FLEET_MIN_GOOGLE_DOMAINS &&
    microsoft >= COPY_CANARY_FLEET_MIN_MICROSOFT_DOMAINS
  );
}

export function fleetIsReady(
  fleet: CopyCanaryFleetRecord | null | undefined,
  released?: ReleasedCanaryFleetRecord | null,
): boolean {
  const clean = sanitizeCopyCanaryFleet(fleet, released);
  if (!clean?.emails.length) return false;
  return fleetMeetsEspMinimum(clean);
}

/** D60 — already asked, already bought, or waiting on nameservers. */
export function canaryFleetBuyAlreadyOpen(
  fleet: CopyCanaryFleetRecord | null | undefined,
  actions: Array<{
    kind: string;
    status: string;
    detail?: Record<string, unknown>;
  }>,
  released?: ReleasedCanaryFleetRecord | null,
): boolean {
  const clean = sanitizeCopyCanaryFleet(fleet, released);
  if (clean?.domains.length || clean?.emails.length) return true;
  if (clean && clean.status !== "missing") return true;
  return actions.some((row) => {
    if (row.kind !== "buy_canary_fleet") return false;
    if (
      row.status !== "pending" &&
      row.status !== "approved" &&
      row.status !== "executed"
    ) {
      return false;
    }
    const domains = Array.isArray(row.detail?.domains)
      ? (row.detail!.domains as unknown[]).map((value) =>
          String(value).toLowerCase(),
        )
      : [];
    if (
      domains.length &&
      domains.every((domain) => isReleasedCanaryDomain(domain, released))
    ) {
      return false;
    }
    return true;
  });
}

export function domainsFromCanaryBuyActions(
  actions: Array<{
    id?: string;
    kind: string;
    status: string;
    detail?: Record<string, unknown>;
  }>,
  released?: ReleasedCanaryFleetRecord | null,
): { actionId: string; domains: string[]; emails: string[] } | null {
  const rows = [...actions].reverse();
  for (const row of rows) {
    if (row.kind !== "buy_canary_fleet") continue;
    if (row.status !== "executed" && row.status !== "approved") continue;
    const domains = Array.isArray(row.detail?.domains)
      ? (row.detail!.domains as unknown[])
          .map((value) => String(value).toLowerCase())
          .filter((domain) => domain && !isReleasedCanaryDomain(domain, released))
      : [];
    if (!domains.length) continue;
    const emails = Array.isArray(row.detail?.emails)
      ? (row.detail!.emails as unknown[])
          .map((value) => String(value).toLowerCase())
          .filter((email) => email && !isReleasedCanaryEmail(email, released))
      : [];
    return { actionId: row.id ?? "", domains, emails };
  }
  return null;
}
