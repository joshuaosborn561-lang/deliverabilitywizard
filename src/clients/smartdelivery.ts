import { apiRequest, ApiError } from "../lib/http.js";
import {
  classifySeedEsp,
  mailFolderOf,
  normalizeSenderEspFamily,
  type EspFamily,
} from "../lib/esp.js";
import type {
  BlacklistedDomainHit,
  BlacklistRow,
  CreatedPlacementTest,
  DomainBlacklistReport,
  MailboxSummaryRow,
  ProviderwiseRow,
  SpamTestSummary,
} from "../types/index.js";

/** Default minimum same-ESP seed placements before trusting same-ESP %. */
export const DEFAULT_MIN_SAME_ESP_SAMPLES = 3;

const BASE_URL = "https://smartdelivery.smartlead.ai/api/v1/";

/** SmartDelivery returns ~10 rows when `limit` is omitted; page in this size. */
export const DEFAULT_TEST_LIST_LIMIT = 100;

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

/**
 * Automated (recurring) placement test. Same shape as a manual test plus the
 * recurrence window: SmartDelivery re-runs the parent test every `every_days`
 * from `schedule_start_time` until `test_end_date` (or until stopped).
 */
/**
 * Allowed send window for a recurring test. SmartDelivery requires this
 * object on every /spam-test/schedule call; their request schema for it
 * isn't publicly documented (confirmed the shape via a live validation
 * probe — see schedulerCronValue() in campaignScanner.ts).
 */
export interface SchedulerCronValue {
  tz: string;
  /** Day-of-week numbers, 0 (Sunday) - 6 (Saturday). */
  days: number[];
  /** "HH:MM", 24-hour. */
  startHour: string;
  /** "HH:MM", 24-hour. */
  endHour: string;
}

export interface CreateAutomatedPlacementInput
  extends CreateManualPlacementInput {
  /** Recurrence interval in days, e.g. 7 for weekly. */
  every_days: number;
  /** ISO 8601 timestamp for the first run. */
  schedule_start_time: string;
  scheduler_cron_value: SchedulerCronValue;
  /**
   * ISO 8601 timestamp. SmartDelivery requires this on every call — there is
   * no way to omit it for an open-ended schedule. See OPEN_ENDED_TEST_DAYS
   * in campaignScanner.ts for how an "open-ended" test still gets a value.
   */
  test_end_date: string;
  /** SmartDelivery requires this on every call — see CreateManualPlacementInput. */
  provider_ids: number[];
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

  /**
   * List placement tests. SmartDelivery's report endpoint defaults to a short
   * page (~10) when `limit` is omitted — after the 2026-08-05 backfill that
   * silently hid most ACTIVE autos from the scanner/reconciler. When the
   * caller does not pass `limit`/`offset`, this paginates with
   * {@link DEFAULT_TEST_LIST_LIMIT} until a short page.
   */
  async listTests(
    body: Record<string, unknown> = {},
  ): Promise<SpamTestSummary[]> {
    if (body.limit !== undefined || body.offset !== undefined) {
      return apiRequest<SpamTestSummary[]>(
        BASE_URL,
        this.apiKey,
        "spam-test/report",
        { method: "POST", body },
      );
    }

    const all: SpamTestSummary[] = [];
    let offset = 0;
    const limit = DEFAULT_TEST_LIST_LIMIT;
    for (let page = 0; page < 50; page += 1) {
      const raw = await apiRequest<unknown>(
        BASE_URL,
        this.apiKey,
        "spam-test/report",
        { method: "POST", body: { ...body, limit, offset } },
      );
      const rows = normalizeTestList(raw);
      all.push(...rows);
      if (rows.length < limit) break;
      offset += rows.length;
    }
    return all;
  }

  /**
   * The report list omits `campaign_id`. Fetch details for every row that
   * still needs linkage so scanner coverage + reconciler delete can key off
   * the real campaign — including STOPPED/COMPLETED history that used to be
   * skipped and left as "orphans".
   */
  async enrichCampaignIds(
    tests: SpamTestSummary[],
  ): Promise<SpamTestSummary[]> {
    const out: SpamTestSummary[] = [];
    for (const test of tests) {
      if (campaignIdOf(test)) {
        out.push(test);
        continue;
      }
      const id = testIdOf(test);
      if (!id) {
        out.push(test);
        continue;
      }
      try {
        const details = await this.getTestDetails(id);
        const cid = details.campaign_id;
        out.push(
          cid === undefined || cid === null
            ? test
            : { ...test, campaign_id: cid as string | number },
        );
      } catch {
        out.push(test);
      }
    }
    return out;
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

  /**
   * Create a recurring placement test.
   * POST /spam-test/schedule
   */
  createAutomatedPlacement(
    input: CreateAutomatedPlacementInput,
  ): Promise<CreatedPlacementTest> {
    return apiRequest<CreatedPlacementTest>(
      BASE_URL,
      this.apiKey,
      "spam-test/schedule",
      { method: "POST", body: input },
    );
  }

  /**
   * Stop an active automated test before its end date. Stops future runs of
   * the parent test; already-completed runs keep their reports.
   * PUT /spam-test/{id}/stop
   */
  stopAutomatedTest(spamTestId: string | number): Promise<unknown> {
    return apiRequest(
      BASE_URL,
      this.apiKey,
      `spam-test/${spamTestId}/stop`,
      { method: "PUT", body: {} },
    );
  }

  /**
   * Permanently delete placement tests. POST /spam-test/delete
   * Body: `{ spamTestIds: number[] }` (SmartDelivery validation requires this key).
   */
  deleteTests(spamTestIds: Array<string | number>): Promise<unknown> {
    const ids = [
      ...new Set(
        spamTestIds
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    ];
    if (!ids.length) return Promise.resolve({ message: "nothing to delete" });
    return apiRequest(BASE_URL, this.apiKey, "spam-test/delete", {
      method: "POST",
      body: { spamTestIds: ids },
    });
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

  getSenderAccountReport(spamTestId: string | number): Promise<unknown> {
    return apiRequest(
      BASE_URL,
      this.apiKey,
      `spam-test/report/${spamTestId}/sender-account-wise`,
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

/**
 * True when a test recurs. SmartDelivery's exact `test_type` strings are not
 * documented, so treat the presence of recurrence fields as authoritative and
 * fall back to a name match.
 */
export function isAutomatedTest(test: SpamTestSummary): boolean {
  if (typeof test.every_days === "number" && test.every_days > 0) return true;
  if (test.schedule_start_time) return true;
  return /auto|schedul|recur/i.test(String(test.test_type ?? ""));
}

/**
 * True when an automated test still has future runs worth stopping. Unknown or
 * missing statuses are treated as stoppable so we fail safe toward stopping a
 * test whose campaign is no longer active.
 */
export function isTestStoppable(test: SpamTestSummary): boolean {
  const status = String(test.status ?? "").toLowerCase();
  if (!status) return true;
  return !/stop|complet|cancel|expir|fail|delet|finish|end/i.test(status);
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

export interface SenderInboxRate {
  email: string;
  /**
   * Decision rate for display / ranking.
   * When `scoredSameEsp` is true this is same-ESP %. When false it may be the
   * blended all-ESP % — D32 forbids using that blended value to rotate.
   */
  inboxRate: number;
  /** All seed ESPs blended (G Suite + Office365). Never a rotation signal (D32). */
  inboxRateAll?: number;
  /** Same-ESP only (Gmail→G Suite / Outlook→O365). */
  inboxRateSameEsp?: number;
  sameEspSamples?: number;
  allEspSamples?: number;
  senderEsp?: EspFamily;
  /** True only when inboxRate was computed from enough same-ESP seeds. */
  scoredSameEsp?: boolean;
  testId?: string;
}

export interface ParseSenderInboxRateOptions {
  /** email (lowercase) → Smartlead account type */
  senderTypeByEmail?: Map<string, string | undefined>;
  /**
   * Prefer same-ESP % when we have enough matching seed samples.
   * Default true.
   */
  preferSameEsp?: boolean;
  /** Minimum same-ESP seed placements required (default 3). */
  minSameEspSamples?: number;
}

/** Parse sender-account-wise report into email → inbox rate rows. */
export function parseSenderInboxRates(
  raw: unknown,
  testId?: string,
  options: ParseSenderInboxRateOptions = {},
): SenderInboxRate[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).result as unknown[]) ||
        ((raw as Record<string, unknown>).data as unknown[]) ||
        ((raw as Record<string, unknown>).items as unknown[]) ||
        []
      : [];

  const preferSameEsp = options.preferSameEsp !== false;
  const minSame =
    options.minSameEspSamples ?? DEFAULT_MIN_SAME_ESP_SAMPLES;

  const out: SenderInboxRate[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const email = String(
      obj.email || obj.from_email || obj.sender_email || "",
    ).trim();
    if (!email) continue;

    const senderEsp = normalizeSenderEspFamily(
      options.senderTypeByEmail?.get(email.toLowerCase()),
    );
    const parsed = extractSenderInboxRates(obj, senderEsp);
    if (typeof parsed.all !== "number" && typeof parsed.same !== "number") {
      continue;
    }

    const useSame =
      preferSameEsp &&
      senderEsp !== "other" &&
      typeof parsed.same === "number" &&
      (parsed.sameSamples ?? 0) >= minSame;

    // Prefer same-ESP for the decision field when eligible. When preferSameEsp
    // is on but samples are thin, still expose the blended % for display —
    // remediation must ignore it (D32 / scoredSameEsp=false).
    const inboxRate = useSame
      ? parsed.same!
      : (parsed.all ?? parsed.same);
    if (typeof inboxRate !== "number") continue;

    out.push({
      email,
      inboxRate,
      inboxRateAll: parsed.all,
      inboxRateSameEsp: parsed.same,
      sameEspSamples: parsed.sameSamples,
      allEspSamples: parsed.allSamples,
      senderEsp,
      scoredSameEsp: useSame,
      testId,
    });
  }
  return out;
}

function extractSenderInboxRates(
  obj: Record<string, unknown>,
  senderEsp: EspFamily,
): {
  all?: number;
  same?: number;
  allSamples?: number;
  sameSamples?: number;
} {
  if (Array.isArray(obj.details)) {
    const all = inboxRateFromSeedDetails(obj.details);
    const same =
      senderEsp === "other"
        ? undefined
        : inboxRateFromSeedDetails(obj.details, { sameEspAs: senderEsp });
    return {
      all: all?.rate,
      same: same?.rate,
      allSamples: all?.samples,
      sameSamples: same?.samples,
    };
  }

  const details =
    obj.details && typeof obj.details === "object" && !Array.isArray(obj.details)
      ? (obj.details as Record<string, unknown>)
      : obj;

  let rate: number | undefined =
    typeof details.avg_inbox_rate === "number"
      ? details.avg_inbox_rate
      : typeof details.inbox_rate === "number"
        ? details.inbox_rate
        : typeof details.placement_score === "number"
          ? details.placement_score
          : typeof obj.avg_inbox_rate === "number"
            ? obj.avg_inbox_rate
            : typeof obj.inbox_rate === "number"
              ? obj.inbox_rate
              : undefined;

  if (rate === undefined) {
    const inboxCount =
      typeof details.inbox_count === "number"
        ? details.inbox_count
        : typeof obj.inbox_count === "number"
          ? obj.inbox_count
          : undefined;
    const total =
      typeof details.adjusted_total_email_count === "number"
        ? details.adjusted_total_email_count
        : typeof details.total_email_count === "number"
          ? details.total_email_count
          : typeof obj.adjusted_total_email_count === "number"
            ? obj.adjusted_total_email_count
            : typeof obj.total_email_count === "number"
              ? obj.total_email_count
              : undefined;
    if (
      typeof inboxCount === "number" &&
      typeof total === "number" &&
      total > 0
    ) {
      rate = (inboxCount / total) * 100;
    }
  }

  return { all: rate, same: undefined, allSamples: undefined, sameSamples: 0 };
}

export interface SeedInboxRateResult {
  rate: number;
  samples: number;
  inbox: number;
}

/** Compute inbox % from seed placement rows with mail_folder = Inbox/Spam/... */
export function inboxRateFromSeedDetails(
  details: unknown[],
  options: { sameEspAs?: EspFamily } = {},
): SeedInboxRateResult | undefined {
  let total = 0;
  let inbox = 0;
  for (const item of details) {
    const folder = mailFolderOf(item);
    if (!folder) continue;
    if (options.sameEspAs && options.sameEspAs !== "other") {
      const seedEsp = classifySeedEsp(item);
      if (seedEsp !== options.sameEspAs) continue;
    }
    total += 1;
    if (folder.toLowerCase() === "inbox") inbox += 1;
  }
  if (total === 0) return undefined;
  return { rate: (inbox / total) * 100, samples: total, inbox };
}
