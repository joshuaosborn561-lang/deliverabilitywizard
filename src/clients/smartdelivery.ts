import { apiRequest, ApiError } from "../lib/http.js";
import type {
  BlacklistedDomainHit,
  BlacklistRow,
  CreatedPlacementTest,
  DomainBlacklistReport,
  MailboxSummaryRow,
  ProviderwiseRow,
  SpamTestSummary,
} from "../types/index.js";

const BASE_URL = "https://smartdelivery.smartlead.ai/api/v1/";

export interface CreateManualPlacementInput {
  test_name: string;
  description?: string;
  spam_filters: string[];
  link_checker: boolean;
  campaign_id: number;
  sequence_mapping_id: number;
  provider_ids?: number[];
  sender_accounts: string[];
  all_email_sent_without_time_gap?: boolean;
  min_time_btwn_emails?: number;
  min_time_unit?: "minutes" | "hours" | "days";
  is_warmup?: boolean;
}

export class SmartDeliveryClient {
  constructor(private readonly apiKey: string) {}

  /**
   * Probes SmartDelivery to confirm the account has been provisioned.
   * Returns a short diagnostic string on success; throws if access is inactive.
   */
  async assertAccessActive(): Promise<string> {
    try {
      await this.listTests({});
      return "list-tests-ok";
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 403) {
          throw new Error(
            "SmartDelivery API access is not active for this key. Contact support@smartlead.ai to provision smartdelivery.smartlead.ai access before relying on this service.",
          );
        }
        if (error.status === 404) {
          throw new Error(
            "SmartDelivery endpoint not found — access may not be provisioned yet. Contact support@smartlead.ai.",
          );
        }
      }
      // Fallback probe
      try {
        await this.getSeedProviders();
        return "seed-providers-ok";
      } catch (inner) {
        const message =
          inner instanceof Error ? inner.message : String(inner);
        throw new Error(
          `SmartDelivery access check failed (${message}). Confirm SmartDelivery is enabled for this account.`,
        );
      }
    }
  }

  listTests(body: Record<string, unknown> = {}): Promise<SpamTestSummary[]> {
    return apiRequest<SpamTestSummary[]>(
      BASE_URL,
      this.apiKey,
      "spam-test/report",
      { method: "POST", body },
    );
  }

  getTestDetails(spamTestId: string | number): Promise<Record<string, unknown>> {
    return apiRequest<Record<string, unknown>>(
      BASE_URL,
      this.apiKey,
      `spam-test/${spamTestId}`,
    );
  }

  createManualPlacement(
    input: CreateManualPlacementInput,
  ): Promise<CreatedPlacementTest> {
    return apiRequest<CreatedPlacementTest>(
      BASE_URL,
      this.apiKey,
      "spam-test/manual",
      { method: "POST", body: input },
    );
  }

  getSeedProviders(): Promise<unknown> {
    return apiRequest<unknown>(BASE_URL, this.apiKey, "spam-test/seed/providers");
  }

  async resolveProviderIds(configured: number[]): Promise<number[]> {
    if (configured.length) return configured;

    const raw = await this.getSeedProviders();
    const ids = collectIntegerIds(raw);
    return [...new Set(ids)];
  }

  getProviderwiseReport(
    spamTestId: string | number,
  ): Promise<{ status?: string; result?: ProviderwiseRow[]; overallTotalCount?: number }> {
    return apiRequest(
      BASE_URL,
      this.apiKey,
      `spam-test/report/${spamTestId}/providerwise`,
      { method: "POST", body: {} },
    );
  }

  getMailboxSummary(): Promise<MailboxSummaryRow[]> {
    return apiRequest<MailboxSummaryRow[]>(
      BASE_URL,
      this.apiKey,
      "spam-test/report/mailboxes-summary",
    );
  }

  getDomainBlacklist(spamTestId: string | number): Promise<BlacklistRow[] | Record<string, unknown>> {
    return apiRequest(
      BASE_URL,
      this.apiKey,
      `spam-test/report/${spamTestId}/domain-blacklist`,
    );
  }

  getIpBlacklist(spamTestId: string | number): Promise<BlacklistRow[] | Record<string, unknown>> {
    return apiRequest(
      BASE_URL,
      this.apiKey,
      `spam-test/report/${spamTestId}/blacklist`,
    );
  }
}

function collectIntegerIds(value: unknown, depth = 0): number[] {
  if (depth > 8 || value == null) return [];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return [value];
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return [Number(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectIntegerIds(item, depth + 1));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const preferredKeys = [
      "provider_id",
      "providerId",
      "id",
      "seed_id",
      "seedId",
    ];
    const out: number[] = [];
    for (const key of preferredKeys) {
      if (key in obj) out.push(...collectIntegerIds(obj[key], depth + 1));
    }
    // Also walk nested groups/providers collections
    for (const [key, nested] of Object.entries(obj)) {
      if (preferredKeys.includes(key)) continue;
      if (
        key.toLowerCase().includes("provider") ||
        key.toLowerCase().includes("group") ||
        key === "result" ||
        key === "data"
      ) {
        out.push(...collectIntegerIds(nested, depth + 1));
      }
    }
    return out;
  }
  return [];
}

export function normalizeTestList(raw: unknown): SpamTestSummary[] {
  if (Array.isArray(raw)) return raw as SpamTestSummary[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["data", "result", "results", "tests", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as SpamTestSummary[];
    }
  }
  return [];
}

export function testIdOf(test: SpamTestSummary): string | undefined {
  const id = test.spam_test_id ?? test.id;
  return id === undefined || id === null ? undefined : String(id);
}

export function campaignIdOf(test: SpamTestSummary): string | undefined {
  if (test.campaign_id === undefined || test.campaign_id === null) return undefined;
  return String(test.campaign_id);
}

export function asBlacklistRows(
  raw: BlacklistRow[] | Record<string, unknown>,
): BlacklistRow[] {
  if (Array.isArray(raw)) return raw as BlacklistRow[];
  if (!raw || typeof raw !== "object") return [];
  for (const key of ["data", "result", "results", "items"]) {
    const value = (raw as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as BlacklistRow[];
  }
  return [];
}

export function asDomainBlacklistReports(
  raw: unknown,
): DomainBlacklistReport[] {
  if (Array.isArray(raw)) return raw as DomainBlacklistReport[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["data", "result", "results", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as DomainBlacklistReport[];
    }
  }
  return [];
}

/** Extract sending domain from an email address. */
export function domainFromEmail(email?: string | null): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0 || at === trimmed.length - 1) return undefined;
  const domain = trimmed.slice(at + 1).replace(/[>\]]+$/, "");
  return domain || undefined;
}

/**
 * Parse SmartDelivery domain-blacklist payload into explicit sending-domain hits.
 * Shape: [{ from_email, seed_accounts: [{ domain_blacklisted }] }]
 */
export function parseDomainBlacklistHits(raw: unknown): BlacklistedDomainHit[] {
  const reports = asDomainBlacklistReports(raw);
  const hits: BlacklistedDomainHit[] = [];
  const seen = new Set<string>();

  for (const report of reports) {
    const fromEmail = report.from_email?.trim();
    const domain =
      report.domain?.trim().toLowerCase() || domainFromEmail(fromEmail);
    if (!domain) continue;

    const seeds = report.seed_accounts ?? [];
    const blacklistedSeeds = seeds.filter((s) => s.domain_blacklisted === true);
    const flaggedOnParent = report.domain_blacklisted === true;
    if (!blacklistedSeeds.length && !flaggedOnParent) continue;

    const key = domain.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    hits.push({
      domain,
      fromEmail,
      source: "domain-blacklist",
      totalHits: blacklistedSeeds.length || (flaggedOnParent ? 1 : 0),
      seedEspHits: [
        ...new Set(
          blacklistedSeeds
            .map((s) => s.esp?.trim())
            .filter((x): x is string => Boolean(x)),
        ),
      ],
    });
  }

  return hits;
}

/**
 * Parse IP blacklist rows and attribute each hit to the sender's domain.
 */
export function parseIpBlacklistHits(raw: unknown): BlacklistedDomainHit[] {
  const rows = asBlacklistRows(
    (raw as BlacklistRow[] | Record<string, unknown>) ?? [],
  );
  const hits: BlacklistedDomainHit[] = [];

  for (const row of rows) {
    if (!isIpBlacklisted(row)) continue;
    const fromEmail =
      row.reply?.from_email ??
      row["reply.from_email"] ??
      row.from_email;
    const domain =
      domainFromEmail(fromEmail) ||
      // fallback only if it looks like a sending domain, not an ESP seed domain
      (row.domain && !isCommonEspDomain(row.domain) ? row.domain.toLowerCase() : undefined);
    if (!domain) continue;

    hits.push({
      domain,
      fromEmail: fromEmail?.trim(),
      source: "ip-blacklist",
      ip: row.ip,
      listName: row.blacklist_type_value,
      totalHits: row.total_blacklist,
      details: row.details,
    });
  }

  return hits;
}

function isIpBlacklisted(row: BlacklistRow): boolean {
  if (typeof row.total_blacklist === "number" && row.total_blacklist > 0) {
    return true;
  }
  const details = String(row.details ?? "").toLowerCase();
  if (details.includes("listed") && !details.includes("not listed")) {
    return true;
  }
  // SmartDelivery sometimes uses details like "Spam" with total_blacklist > 0 already handled;
  // also treat explicit spam folder + blacklist count payloads as hits.
  if (details === "spam" && (row.ip || row.blacklist_type_value)) {
    return true;
  }
  return false;
}

function isCommonEspDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return [
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "aol.com",
    "icloud.com",
    "me.com",
    "msn.com",
  ].includes(d);
}

/** Unique sending domains from a list of hits, preserving first-seen order. */
export function uniqueBlacklistedDomains(hits: BlacklistedDomainHit[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    const key = hit.domain.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit.domain);
  }
  return out;
}
