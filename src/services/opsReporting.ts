import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import type { InventoryBook } from "./inventory.js";
import {
  accountEmail,
  campaignIdsOf,
} from "../clients/smartlead.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { humanizeAlertError, isRateLimitNoise } from "../lib/alertNoise.js";
import type { StateStore } from "../state/store.js";
import { sleep } from "../lib/http.js";
import type {
  ProviderwiseRow,
  SpamTestSummary,
} from "../types/index.js";

/** D126 — ops Placement tab is live senders, never Canary copy tests. */
export const CANARY_COPY_TITLE_PHRASE = "canary copy";

export function titleHasCanaryCopyPhrase(
  ...titles: Array<string | undefined | null>
): boolean {
  return titles.some((title) =>
    String(title ?? "").toLowerCase().includes(CANARY_COPY_TITLE_PHRASE),
  );
}

export function isLiveSendingCampaignStatus(
  status: string | undefined | null,
): boolean {
  const value = String(status ?? "").toUpperCase();
  return value === "ACTIVE" || value === "START";
}

function resolveCampaignId(
  mappedId: number | undefined,
  test: SpamTestSummary,
): number | undefined {
  if (mappedId != null && Number.isFinite(mappedId)) return mappedId;
  const raw = campaignIdOf(test);
  if (raw == null) return undefined;
  const id = Number(raw);
  return Number.isFinite(id) ? id : undefined;
}

export interface PlacementResultRow {
  id: string;
  name: string;
  campaignId?: number;
  campaignName?: string;
  status: string;
  createdAt?: string;
  runNumber?: number;
  inboxPercent?: number;
  tabPercent?: number;
  spamPercent?: number;
  googleInboxPercent?: number;
  microsoftInboxPercent?: number;
  totalSeeds: number;
  providers: Array<{ name: string; inboxPercent: number }>;
}

export interface PlacementResults {
  generatedAt: string;
  rows: PlacementResultRow[];
  errors: string[];
  stale?: boolean;
}

/** D126 — live-sender cap after canary copy is filtered out. */
export const OPS_PLACEMENT_REPORT_CAP = 40;
const OPS_PLACEMENT_LIST_PAGE = 100;
const OPS_PLACEMENT_LIST_MAX_PAGES = 8;

export interface FleetSummary {
  generatedAt: string;
  totalMailboxes: number;
  sendingMailboxes: number;
  activeCampaigns: number;
  disconnectedMailboxes: number;
  stale?: boolean;
  error?: string;
}

function pct(value: number, total: number): number | undefined {
  return total > 0 ? (value / total) * 100 : undefined;
}

function providerInboxPercent(row: ProviderwiseRow): number | undefined {
  if (typeof row.inbox_rate === "number") return row.inbox_rate;
  const inbox = row.inbox_count;
  if (typeof inbox !== "number") return undefined;
  const total =
    (typeof row.adjusted_total_email_count === "number" &&
    row.adjusted_total_email_count > 0
      ? row.adjusted_total_email_count
      : undefined) ??
    (typeof row.total_email_count === "number" && row.total_email_count > 0
      ? row.total_email_count
      : undefined) ??
    (typeof row.mailbox_count === "number" && row.mailbox_count > 0
      ? row.mailbox_count
      : undefined) ??
    [row.inbox_count, row.tab_count, row.spam_count]
      .filter((count): count is number => typeof count === "number")
      .reduce((sum, count) => sum + count, 0);
  return total > 0 ? (inbox / total) * 100 : undefined;
}

function overallFromTest(
  test: SpamTestSummary,
): Pick<
  PlacementResultRow,
  "inboxPercent" | "tabPercent" | "spamPercent" | "totalSeeds"
> {
  const inbox = Number(test.inbox_count ?? 0);
  const tab = Number(test.tab_count ?? 0);
  const spam = Number(test.spam_count ?? 0);
  const counted = inbox + tab + spam;
  const total =
    typeof test.adjusted_total_email_count === "number" &&
    test.adjusted_total_email_count > 0
      ? test.adjusted_total_email_count
      : counted;
  return {
    inboxPercent: pct(inbox, total),
    tabPercent: pct(tab, total),
    spamPercent: pct(spam, total),
    totalSeeds: total,
  };
}

export class PlacementResultsService {
  private cache:
    | { expiresAt: number; value: PlacementResults }
    | undefined;
  private inFlight: Promise<PlacementResults> | null = null;
  private readonly forceRefreshFloorMs = 30 * 1000;

  constructor(
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly book: InventoryBook,
    private readonly state: StateStore,
    private readonly cacheMs = 5 * 60 * 1000,
  ) {}

  async get(force = false): Promise<PlacementResults> {
    if (this.inFlight) return this.inFlight;
    if (
      this.cache &&
      ((!force && this.cache.expiresAt > Date.now()) ||
        (force &&
          Date.now() -
            Date.parse(this.cache.value.generatedAt) <
            this.forceRefreshFloorMs))
    ) {
      return this.cache.value;
    }
    this.inFlight = this.loadSafe(force).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private fromPersisted(): PlacementResults | null {
    const snapshot = this.state.getPlacementResults();
    if (!snapshot?.rows?.length) return null;
    return {
      generatedAt: snapshot.generatedAt,
      rows: snapshot.rows.map((row) => ({
        ...row,
        providers: [...row.providers],
      })),
      errors: [],
      stale: true,
    };
  }

  private persist(value: PlacementResults): void {
    if (!value.rows.length) return;
    this.state.setPlacementResults({
      generatedAt: value.generatedAt,
      rows: value.rows,
    });
    void this.state.save().catch((error) => {
      console.warn("[ops-placement] snapshot save failed", error);
    });
  }

  private async loadSafe(force: boolean): Promise<PlacementResults> {
    try {
      return await this.load(force);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = this.cache?.value ?? this.fromPersisted();
      const note = humanizeAlertError(`listTests: ${message}`);
      if (fallback) {
        const value = {
          ...fallback,
          stale: true,
          errors: uniqueErrors([note, ...(fallback.errors ?? [])]),
        };
        this.cache = { expiresAt: Date.now() + this.cacheMs, value };
        return value;
      }
      return {
        generatedAt: new Date().toISOString(),
        rows: [],
        errors: [note],
      };
    }
  }

  private async load(force: boolean): Promise<PlacementResults> {
    const errors: string[] = [];
    const previousById = new Map(
      (this.cache?.value ?? this.fromPersisted())?.rows.map((row) => [
        row.id,
        row,
      ]) ?? [],
    );

    const liveById = new Map<number, { name: string }>();
    let campaignsLoaded = false;
    try {
      // D132 — the board reads the shared account book, never its own fetch.
      const campaigns = (await this.book.get()).campaigns;
      campaignsLoaded = true;
      for (const campaign of campaigns) {
        const id = Number(campaign.id);
        if (!Number.isFinite(id)) continue;
        if (!isLiveSendingCampaignStatus(campaign.status)) continue;
        if (isAnyShellCampaign(campaign)) continue;
        if (titleHasCanaryCopyPhrase(campaign.name)) continue;
        liveById.set(id, { name: String(campaign.name ?? "") });
      }
    } catch (error) {
      errors.push(
        humanizeAlertError(
          `campaigns: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }

    const campaignByTest = new Map<
      string,
      { campaignId: number; campaignName: string }
    >();
    for (const record of Object.values(this.state.get().testedCampaigns)) {
      for (const testId of record.testIds) {
        campaignByTest.set(String(testId), {
          campaignId: record.campaignId,
          campaignName: record.campaignName,
        });
      }
    }

    const listed = await this.listNewestTests(
      (test) =>
        isLivePlacementTest(test, {
          campaignByTest,
          liveById,
          campaignsLoaded,
        }),
      errors,
    );

    const tests = listed
      .filter((test) =>
        isLivePlacementTest(test, {
          campaignByTest,
          liveById,
          campaignsLoaded,
        }),
      )
      // Match the production monitor's rate-limit ceiling — after the
      // canary-copy tests are gone, so live senders still get reports.
      .slice(0, 40);

    const gapMs = process.env.NODE_TEST_CONTEXT ? 0 : 250;
    const rows: PlacementResultRow[] = new Array(tests.length);
    let skipProviders = false;
    for (let index = 0; index < tests.length; index += 1) {
      const test = tests[index]!;
      const id = testIdOf(test);
      if (!id) continue;
      const mapped = campaignByTest.get(id);
      const campaignId = resolveCampaignId(mapped?.campaignId, test);
      const previous = previousById.get(id);
      const row: PlacementResultRow = {
        id,
        name: String(test.test_name ?? `Test ${id}`),
        campaignId,
        campaignName:
          mapped?.campaignName ||
          (campaignId != null ? liveById.get(campaignId)?.name : undefined),
        status: String(test.status ?? "UNKNOWN"),
        createdAt: test.created_at,
        runNumber: test.current_test_run_no,
        ...overallFromTest(test),
        providers: previous?.providers ? [...previous.providers] : [],
        googleInboxPercent: previous?.googleInboxPercent,
        microsoftInboxPercent: previous?.microsoftInboxPercent,
      };
      const haveEsp =
        typeof row.googleInboxPercent === "number" &&
        typeof row.microsoftInboxPercent === "number";
      if (!skipProviders && (force || !haveEsp)) {
        try {
          applyProviderwise(
            row,
            await this.smartDelivery.getProviderwiseReport(id),
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push(humanizeAlertError(`test ${id}: ${message}`));
          if (isRateLimitNoise(message)) skipProviders = true;
        }
        if (gapMs) await sleep(gapMs);
      }
      rows[index] = row;
    }
    const value = {
      generatedAt: new Date().toISOString(),
      rows: rows.filter(Boolean),
      errors: uniqueErrors(errors),
    };
    this.cache = { expiresAt: Date.now() + this.cacheMs, value };
    this.persist(value);
    return value;
  }

  /**
   * Page SmartDelivery until the live-sender cap is filled. Full-catalog
   * pagination used to 429 the employee refresh before a single provider
   * report ran.
   */
  private async listNewestTests(
    isLive: (test: SpamTestSummary) => boolean,
    errors: string[],
  ): Promise<SpamTestSummary[]> {
    const all: SpamTestSummary[] = [];
    let offset = 0;
    for (let page = 0; page < OPS_PLACEMENT_LIST_MAX_PAGES; page += 1) {
      let raw: unknown;
      try {
        raw = await this.smartDelivery.listTests({
          limit: OPS_PLACEMENT_LIST_PAGE,
          offset,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(humanizeAlertError(`listTests: ${message}`));
        if (all.length) return all;
        throw error;
      }
      const rows = normalizeTestList(raw);
      all.push(...rows);
      const live = all.filter(isLive).length;
      if (rows.length < OPS_PLACEMENT_LIST_PAGE) break;
      if (live >= OPS_PLACEMENT_REPORT_CAP) break;
      offset += rows.length;
    }
    return all.sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    );
  }
}

function isLivePlacementTest(
  test: SpamTestSummary,
  opts: {
    campaignByTest: Map<string, { campaignId: number; campaignName: string }>;
    liveById: Map<number, { name: string }>;
    campaignsLoaded: boolean;
  },
): boolean {
  if (titleHasCanaryCopyPhrase(test.test_name)) return false;
  const id = testIdOf(test);
  const mapped = id ? opts.campaignByTest.get(id) : undefined;
  const campaignId = resolveCampaignId(mapped?.campaignId, test);
  if (campaignId == null) return false;
  if (opts.campaignsLoaded) {
    const live = opts.liveById.get(campaignId);
    if (!live) return false;
    if (titleHasCanaryCopyPhrase(mapped?.campaignName, live.name)) {
      return false;
    }
  } else if (titleHasCanaryCopyPhrase(mapped?.campaignName)) {
    return false;
  }
  return true;
}

function applyProviderwise(
  row: PlacementResultRow,
  report: { result?: ProviderwiseRow[] },
): void {
  const providers = (report.result ?? [])
    .map((provider) => ({
      name: String(
        provider.provider_name ??
          provider.provider ??
          provider.provider_id ??
          "Unknown",
      ),
      inboxPercent: providerInboxPercent(provider),
    }))
    .filter(
      (provider): provider is { name: string; inboxPercent: number } =>
        typeof provider.inboxPercent === "number",
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  row.providers = providers;
  row.googleInboxPercent = providers.find((provider) =>
    /g\s*suite|gmail|google/i.test(provider.name),
  )?.inboxPercent;
  row.microsoftInboxPercent = providers.find((provider) =>
    /office\s*365|outlook|microsoft|o365/i.test(provider.name),
  )?.inboxPercent;
}

function uniqueErrors(errors: string[]): string[] {
  return [...new Set(errors.filter(Boolean))];
}

export class FleetSummaryService {
  private cache: { expiresAt: number; value: FleetSummary } | undefined;
  private inFlight: Promise<FleetSummary> | null = null;
  private readonly forceRefreshFloorMs = 15 * 1000;

  constructor(
    private readonly book: InventoryBook,
    private readonly state: StateStore,
    private readonly cacheMs = 60 * 1000,
  ) {}

  async get(force = false): Promise<FleetSummary> {
    if (this.inFlight) return this.inFlight;
    if (
      this.cache &&
      ((!force && this.cache.expiresAt > Date.now()) ||
        (force &&
          Date.now() -
            Date.parse(this.cache.value.generatedAt) <
            this.forceRefreshFloorMs))
    ) {
      return this.cache.value;
    }
    const persisted = this.fromPersisted();
    if (!force && persisted) {
      this.cache = { expiresAt: Date.now() + this.cacheMs, value: persisted };
      return persisted;
    }
    this.inFlight = this.load()
      .catch((error) => {
        if (!persisted) throw error;
        return {
          ...persisted,
          stale: true,
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private fromPersisted(): FleetSummary | null {
    const snapshot = this.state.getFleetSummary();
    if (!snapshot) return null;
    return {
      ...snapshot,
    };
  }

  private async load(): Promise<FleetSummary> {
    // D132 — the board reads the shared account book, never its own fetch.
    const { campaigns, accounts } = await this.book.get();
    const activeCampaigns = new Set(
      campaigns
        .filter((campaign) =>
          ["ACTIVE", "START"].includes(
            String(campaign.status ?? "").toUpperCase(),
          ),
        )
        .map((campaign) => campaign.id),
    );
    const sending = accounts.filter(
      (account) =>
        Boolean(accountEmail(account)) &&
        campaignIdsOf(account).some((id) => activeCampaigns.has(id)),
    );
    const value: FleetSummary = {
      generatedAt: new Date().toISOString(),
      totalMailboxes: accounts.filter((account) =>
        Boolean(accountEmail(account)),
      ).length,
      sendingMailboxes: new Set(sending.map((account) => account.id)).size,
      activeCampaigns: activeCampaigns.size,
      disconnectedMailboxes: accounts.filter(
        (account) =>
          account.is_smtp_success === false ||
          account.is_imap_success === false,
      ).length,
    };
    this.state.setFleetSummary({
      generatedAt: value.generatedAt,
      totalMailboxes: value.totalMailboxes,
      sendingMailboxes: value.sendingMailboxes,
      activeCampaigns: value.activeCampaigns,
      disconnectedMailboxes: value.disconnectedMailboxes,
    });
    await this.state.save();
    this.cache = { expiresAt: Date.now() + this.cacheMs, value };
    return value;
  }
}
