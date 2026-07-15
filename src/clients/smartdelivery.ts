import { apiRequest, ApiError } from "../lib/http.js";
import type {
  BlacklistRow,
  CreatedPlacementTest,
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
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const key of ["data", "result", "results", "items"]) {
    const value = (raw as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as BlacklistRow[];
  }
  return [];
}
