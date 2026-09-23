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
import {
  humanizeAlertError,
  isMissingSpamTestNoise,
  isRateLimitNoise,
} from "../lib/alertNoise.js";
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
  /** False when the catalog walk 429'd or found fewer live tests than we know exist. */
  complete?: boolean;
  /**
   * Next `spam-test/report` offset. Newest pages are pod-control tests, so a
   * walk that stops early has to resume here instead of starting over.
   */
  listOffset?: number;
}

/** D187 — live-sender cap after canary copy is filtered out (D126). */
export const OPS_PLACEMENT_REPORT_CAP = 80;
const OPS_PLACEMENT_LIST_PAGE = 100;
/** One pass reads a couple of pages, then the next open continues at listOffset. */
const OPS_PLACEMENT_LIST_PAGES_PER_PASS = 2;
/** Fail fast on providerwise pulls — retries stampede a 429 window. */
export const OPS_PLACEMENT_LIVE_RETRIES = 0;
/** Catalog pages do not retry. A 429 keeps listOffset and the next open continues. */
export const OPS_PLACEMENT_LIST_RETRIES = 0;
/** After SmartDelivery 429s the board, do not poke it again for this long. */
export const OPS_PLACEMENT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

export interface FleetSummary {
  generatedAt: string;
  totalMailboxes: number;
  sendingMailboxes: number;
  activeCampaigns: number;
  disconnectedMailboxes: number;
  stale?: boolean;
  error?: string;
}

/**
 * Google or Microsoft inbox % is the result the Placement tab is missing
 * when a row still says UNKNOWN. Inbox-only list rows still need this.
 */
export function placementRowHasResult(row: {
  status?: string;
  googleInboxPercent?: number;
  microsoftInboxPercent?: number;
}): boolean {
  if (String(row.status ?? "").toUpperCase() === "NOT FOUND") return true;
  return (
    typeof row.googleInboxPercent === "number" ||
    typeof row.microsoftInboxPercent === "number"
  );
}

/** A campaign's first mark is not a test run. Rows stamped with it look old. */
const OPS_PLACEMENT_STALE_DATE_MS = 48 * 60 * 60 * 1000;

function numericTestId(id: string): number {
  const value = Number(id);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Highest SmartDelivery id. Numeric, so "1000" beats "999". */
export function newestPlacementTestId(ids: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const id of ids) {
    if (!id) continue;
    if (!best || numericTestId(id) > numericTestId(best)) best = id;
    else if (numericTestId(id) === numericTestId(best) && id > best) best = id;
  }
  return best;
}

/**
 * Date the Placement tab should show: last activity, else the latest
 * scheduled run, else when the test record was created.
 */
export function latestPlacementAt(
  test: SpamTestSummary & { updated_at?: string },
  now = Date.now(),
  allowCreatedAt = true,
): string | undefined {
  const candidates: number[] = [];
  const updated = Date.parse(String(test.updated_at ?? ""));
  if (Number.isFinite(updated)) candidates.push(updated);
  const start = Date.parse(String(test.schedule_start_time ?? ""));
  const every = test.every_days;
  const run = test.current_test_run_no;
  if (
    Number.isFinite(start) &&
    typeof every === "number" &&
    every > 0 &&
    typeof run === "number" &&
    run >= 1
  ) {
    candidates.push(start + (run - 1) * every * 24 * 60 * 60 * 1000);
  }
  const fresh = candidates.filter((stamp) => stamp <= now + 60_000);
  if (fresh.length) return new Date(Math.max(...fresh)).toISOString();
  return allowCreatedAt ? test.created_at : undefined;
}

function placementDateIsStale(row: PlacementResultRow, now = Date.now()): boolean {
  if (!row.createdAt) return true;
  const parsed = Date.parse(row.createdAt);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed > OPS_PLACEMENT_STALE_DATE_MS;
}

/** Google/Microsoft alone is not a finished row. Inbox, spam, seeds, date, and run are the rest of the table. */
function placementRowNeedsScore(row: PlacementResultRow): boolean {
  return (
    !placementRowHasResult(row) ||
    typeof row.inboxPercent !== "number" ||
    typeof row.spamPercent !== "number" ||
    !row.totalSeeds
  );
}

function placementRowNeedsDate(row: PlacementResultRow): boolean {
  return placementDateIsStale(row) || row.runNumber == null;
}

function placementRowIsFilled(row: PlacementResultRow): boolean {
  if (String(row.status ?? "").toUpperCase() === "NOT FOUND") return true;
  return !placementRowNeedsScore(row) && !placementRowNeedsDate(row);
}

function placementDetailsRecord(raw: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["data", "test", "spam_test"]) {
    const nested = raw[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return { ...raw, ...(nested as Record<string, unknown>) };
    }
  }
  return raw;
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
  private rateLimitedUntil = 0;
  private readonly forceRefreshFloorMs = 30 * 1000;

  constructor(
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly book: InventoryBook,
    private readonly state: StateStore,
    private readonly cacheMs = 5 * 60 * 1000,
    private readonly rateLimitCooldownMs = OPS_PLACEMENT_RATE_LIMIT_COOLDOWN_MS,
  ) {}

  async get(force = false): Promise<PlacementResults> {
    if (this.inFlight) return this.inFlight;
    const now = Date.now();
    const fallback = this.cache?.value ?? this.fromPersisted();
    if (now < this.rateLimitedUntil && fallback) {
      const value = this.snapshotView(fallback, {
        stale: true,
        errors: force
          ? [humanizeAlertError("listTests: Rate limit exceeded")]
          : [],
      });
      this.cache = {
        expiresAt: Math.max(this.cache?.expiresAt ?? 0, this.rateLimitedUntil),
        value,
      };
      return value;
    }
    if (
      this.cache &&
      this.snapshotLooksComplete(this.cache.value) &&
      ((!force && this.cache.expiresAt > now) ||
        (force &&
          now - Date.parse(this.cache.value.generatedAt) <
            this.forceRefreshFloorMs))
    ) {
      return force ? this.cache.value : this.quietView(this.cache.value);
    }

    const generatedAtMs = fallback ? Date.parse(fallback.generatedAt) : NaN;
    const snapshotFresh =
      Number.isFinite(generatedAtMs) && now - generatedAtMs < this.cacheMs;
    if (
      !force &&
      fallback &&
      snapshotFresh &&
      this.snapshotLooksComplete(fallback)
    ) {
      const covered = await this.everyLiveCampaignHasRow(fallback);
      if (this.inFlight) return this.inFlight;
      if (covered) {
        const value = this.quietView(fallback);
        this.cache = { expiresAt: generatedAtMs + this.cacheMs, value };
        return value;
      }
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
      complete: snapshot.complete,
      listOffset: snapshot.listOffset,
    };
  }

  /**
   * A saved "complete" board can still be missing campaigns that were never
   * linked to a test id. Tab-open only skips SmartDelivery when every live
   * campaign already has a row.
   */
  private async everyLiveCampaignHasRow(
    value: PlacementResults,
  ): Promise<boolean> {
    try {
      const campaigns = (await this.book.get()).campaigns;
      const covered = new Set(
        value.rows
          .map((row) => row.campaignId)
          .filter((id): id is number => id != null),
      );
      for (const campaign of campaigns) {
        const id = Number(campaign.id);
        if (!Number.isFinite(id)) continue;
        if (!isLiveSendingCampaignStatus(campaign.status)) continue;
        if (isAnyShellCampaign(campaign)) continue;
        if (titleHasCanaryCopyPhrase(campaign.name)) continue;
        if (!covered.has(id)) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * A 4-row leftover from a truncated catalog walk must not block a refresh.
   * A complete persist (or a pre-flag snapshot of 40+, the old D126 cap) can.
   */
  private snapshotLooksComplete(value: PlacementResults): boolean {
    if (!value.rows.length) return false;
    if (value.rows.some((row) => !placementRowHasResult(row))) return false;
    if (value.complete === false) return false;
    if (value.complete === true) return true;
    return value.rows.length >= 40;
  }

  /** Tab-open view: keep the snapshot, drop the red rate-limit banner. */
  private quietView(value: PlacementResults): PlacementResults {
    if (!value.rows.length || !value.errors.length) return value;
    return { ...value, errors: [] };
  }

  private snapshotView(
    fallback: PlacementResults,
    opts: { stale: boolean; errors: string[] },
  ): PlacementResults {
    return {
      generatedAt: fallback.generatedAt,
      rows: fallback.rows,
      errors: uniqueErrors(opts.errors),
      stale: opts.stale,
      complete: fallback.complete,
      listOffset: fallback.listOffset,
    };
  }

  private persist(value: PlacementResults): void {
    if (!value.rows.length) return;
    this.state.setPlacementResults({
      generatedAt: value.generatedAt,
      rows: value.rows,
      complete: value.complete,
      listOffset: value.listOffset,
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
      if (isRateLimitNoise(message)) {
        this.rateLimitedUntil = Date.now() + this.rateLimitCooldownMs;
      }
      const fallback = this.cache?.value ?? this.fromPersisted();
      const note = humanizeAlertError(`listTests: ${message}`);
      if (fallback) {
        const value = this.snapshotView(fallback, {
          stale: true,
          errors: force ? [note] : [],
        });
        this.cache = {
          expiresAt: Math.max(
            Date.now() + this.cacheMs,
            this.rateLimitedUntil,
          ),
          value,
        };
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

    const previousSnapshot = this.cache?.value ?? this.fromPersisted();
    const known = this.assembleLiveRows({
      listedLive: [],
      previousById,
      previousSnapshot,
      liveById,
      campaignsLoaded,
      campaignByTest,
    });
    const coveredKnown = new Set(
      known
        .map((row) => row.campaignId)
        .filter((id): id is number => id != null),
    );
    const missingCampaign =
      campaignsLoaded &&
      [...liveById.keys()].some((id) => !coveredKnown.has(id));
    const isLive = (test: SpamTestSummary) =>
      isLivePlacementTest(test, {
        campaignByTest,
        liveById,
        campaignsLoaded,
      });
    // A board that already has every live campaign does not walk the catalog.
    // That walk is newest-first pod-control pages and 429s before Auto tests.
    // When a campaign is missing, read two pages from the saved offset.
    const listed = missingCampaign
      ? await this.listNewestTests(
          isLive,
          errors,
          force,
          previousSnapshot?.listOffset ?? 0,
        )
      : {
          tests: [] as SpamTestSummary[],
          truncated: false,
          exhausted: true,
          nextOffset: 0,
        };

    const listedLive = listed.tests.filter(isLive);
    const assembled = this.assembleLiveRows({
      listedLive,
      previousById,
      previousSnapshot,
      liveById,
      campaignsLoaded,
      campaignByTest,
    });
    const covered = new Set(
      assembled
        .map((row) => row.campaignId)
        .filter((id): id is number => id != null),
    );
    const uncovered = campaignsLoaded
      ? [...liveById.keys()].filter((id) => !covered.has(id)).length
      : 0;
    const membershipSettled =
      !campaignsLoaded ||
      liveById.size === 0 ||
      uncovered === 0 ||
      listed.exhausted;

    const gapMs = process.env.NODE_TEST_CONTEXT ? 0 : 250;
    let skipProviders = false;
    // Finish one row before the next. A 429 used to leave every row with a
    // different hole: Google without Inbox, or a score without a date.
    for (const row of assembled) {
      if (skipProviders) break;
      if (!placementRowNeedsScore(row) && !placementRowNeedsDate(row)) continue;
      try {
        if (placementRowNeedsScore(row)) {
          await this.scorePlacementRow(row);
          if (gapMs) await sleep(gapMs);
        }
        if (skipProviders) break;
        if (placementRowNeedsDate(row)) {
          await this.refreshPlacementDate(row);
          if (gapMs) await sleep(gapMs);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isMissingSpamTestNoise(message)) {
          row.status = "NOT FOUND";
          continue;
        }
        if (isRateLimitNoise(message)) {
          this.rateLimitedUntil = Date.now() + this.rateLimitCooldownMs;
          skipProviders = true;
          if (force) {
            errors.push(humanizeAlertError(`test ${row.id}: ${message}`));
          }
        } else {
          errors.push(humanizeAlertError(`test ${row.id}: ${message}`));
        }
      }
    }

    const filled = assembled.filter((row) => placementRowIsFilled(row)).length;
    const value: PlacementResults = {
      generatedAt: new Date().toISOString(),
      rows: assembled,
      errors: uniqueErrors(force ? errors : []),
      listOffset: listed.nextOffset,
      complete:
        membershipSettled &&
        !listed.truncated &&
        filled === assembled.length &&
        assembled.length > 0,
      stale: (listed.truncated || filled < assembled.length) && assembled.length > 0,
    };
    if (!assembled.length) {
      return {
        generatedAt: value.generatedAt,
        rows: [],
        errors: uniqueErrors(errors),
      };
    }
    if (shouldPersistPlacement(previousSnapshot, value)) {
      this.cache = { expiresAt: Date.now() + this.cacheMs, value };
      this.persist(value);
      return value;
    }
    this.cache = {
      expiresAt: Math.max(
        Date.now() + this.rateLimitCooldownMs,
        this.rateLimitedUntil,
      ),
      value,
    };
    return value;
  }

  private async scorePlacementRow(row: PlacementResultRow): Promise<void> {
    const report = await this.smartDelivery.getProviderwiseReport(row.id, {
      retries: OPS_PLACEMENT_LIVE_RETRIES,
    });
    applyProviderwise(row, report);
    const stamped = latestPlacementAt(
      report as SpamTestSummary & { updated_at?: string },
      Date.now(),
      false,
    );
    if (stamped && placementDateIsStale(row)) row.createdAt = stamped;
    const run = Number(
      (report as { current_test_run_no?: unknown; test_run_no?: unknown })
        .current_test_run_no ??
        (report as { test_run_no?: unknown }).test_run_no,
    );
    if (Number.isFinite(run)) row.runNumber = run;
    if (
      typeof row.googleInboxPercent === "number" ||
      typeof row.microsoftInboxPercent === "number"
    ) {
      const reported = String(report.status ?? "").trim();
      if (!reported || reported.toUpperCase() === "UNKNOWN") {
        row.status = "COMPLETED";
      } else {
        row.status = reported;
      }
    } else if (isMissingSpamTestNoise(String(report.status ?? ""))) {
      row.status = "NOT FOUND";
    }
  }

  /** Last run time for a row whose saved date is the schedule's creation. */
  private async refreshPlacementDate(row: PlacementResultRow): Promise<void> {
    const readDetails = this.smartDelivery.getTestDetails?.bind(
      this.smartDelivery,
    );
    if (!readDetails) return;
    const details = placementDetailsRecord(await readDetails(row.id));
    const at = latestPlacementAt(
      details as SpamTestSummary & { updated_at?: string },
    );
    if (at) row.createdAt = at;
    const run = Number(details.current_test_run_no ?? details.test_run_no);
    if (Number.isFinite(run)) row.runNumber = run;
  }

  /**
   * The catalog is newest-first and mostly canary-copy. A 429 after page 1
   * can list only a handful of live tests — and persisting that is how the
   * board got stuck at four rows. Membership is the newest test id stored
   * for each ACTIVE campaign, plus anything this pass did list. Older ids
   * on the same campaign are history; they used to fill the cap and the
   * rate-limit budget, so the tab showed old tests and never finished
   * scoring the current ones.
   */
  private assembleLiveRows(opts: {
    listedLive: SpamTestSummary[];
    previousById: Map<string, PlacementResultRow>;
    previousSnapshot: PlacementResults | null;
    liveById: Map<number, { name: string }>;
    campaignsLoaded: boolean;
    campaignByTest: Map<string, { campaignId: number; campaignName: string }>;
  }): PlacementResultRow[] {
    const byId = new Map<string, PlacementResultRow>();
    const idByCampaign = new Map<number, string>();
    const testedAtByCampaign = new Map<number, string>();
    for (const record of Object.values(this.state.get().testedCampaigns)) {
      if (record.testedAt) testedAtByCampaign.set(record.campaignId, record.testedAt);
    }
    const realDate = (campaignId: number | undefined, createdAt?: string) => {
      if (!createdAt) return undefined;
      if (campaignId == null) return createdAt;
      return createdAt === testedAtByCampaign.get(campaignId) ? undefined : createdAt;
    };
    const remember = (row: PlacementResultRow) => {
      if (!row.id) return;
      if (row.campaignId != null) {
        const currentId = idByCampaign.get(row.campaignId);
        if (currentId && currentId !== row.id) {
          if (numericTestId(row.id) <= numericTestId(currentId)) return;
          byId.delete(currentId);
        }
        idByCampaign.set(row.campaignId, row.id);
      }
      const prior = byId.get(row.id);
      const createdAt = realDate(row.campaignId, row.createdAt ?? prior?.createdAt);
      if (!prior) {
        byId.set(row.id, { ...row, createdAt });
        return;
      }
      byId.set(row.id, {
        ...prior,
        ...row,
        providers: row.providers.length ? row.providers : prior.providers,
        googleInboxPercent: row.googleInboxPercent ?? prior.googleInboxPercent,
        microsoftInboxPercent:
          row.microsoftInboxPercent ?? prior.microsoftInboxPercent,
        inboxPercent: row.inboxPercent ?? prior.inboxPercent,
        spamPercent: row.spamPercent ?? prior.spamPercent,
        tabPercent: row.tabPercent ?? prior.tabPercent,
        createdAt,
        runNumber: row.runNumber ?? prior.runNumber,
        name: row.name || prior.name,
      });
    };

    if (opts.campaignsLoaded) {
      for (const record of Object.values(this.state.get().testedCampaigns)) {
        if (!opts.liveById.has(record.campaignId)) continue;
        const liveName = opts.liveById.get(record.campaignId)?.name;
        if (titleHasCanaryCopyPhrase(record.campaignName, liveName)) continue;
        const id = newestPlacementTestId(record.testIds.map(String));
        if (!id) continue;
        const previous = opts.previousById.get(id);
        remember({
          id,
          name: previous?.name ?? `Auto: ${record.campaignName}`,
          campaignId: record.campaignId,
          campaignName: record.campaignName || liveName,
          status: previous?.status ?? "UNKNOWN",
          createdAt: realDate(record.campaignId, previous?.createdAt),
          runNumber: previous?.runNumber,
          inboxPercent: previous?.inboxPercent,
          tabPercent: previous?.tabPercent,
          spamPercent: previous?.spamPercent,
          googleInboxPercent: previous?.googleInboxPercent,
          microsoftInboxPercent: previous?.microsoftInboxPercent,
          totalSeeds: previous?.totalSeeds ?? 0,
          providers: previous?.providers ? [...previous.providers] : [],
        });
      }
    }

    for (const row of opts.previousSnapshot?.rows ?? []) {
      if (opts.campaignsLoaded && row.campaignId != null) {
        if (!opts.liveById.has(row.campaignId)) continue;
        const liveName = opts.liveById.get(row.campaignId)?.name;
        if (titleHasCanaryCopyPhrase(row.campaignName, row.name, liveName)) {
          continue;
        }
      }
      remember({
        ...row,
        createdAt: realDate(row.campaignId, row.createdAt),
        providers: [...row.providers],
      });
    }

    for (const test of opts.listedLive) {
      const id = testIdOf(test);
      if (!id) continue;
      const mapped = opts.campaignByTest.get(id);
      const campaignId =
        resolveCampaignId(mapped?.campaignId, test) ??
        campaignIdFromAutoName(test.test_name, opts.liveById);
      const previous = opts.previousById.get(id) ?? byId.get(id);
      remember({
        id,
        name: String(test.test_name ?? previous?.name ?? `Test ${id}`),
        campaignId,
        campaignName:
          mapped?.campaignName ||
          (campaignId != null
            ? opts.liveById.get(campaignId)?.name
            : undefined) ||
          previous?.campaignName,
        status: String(test.status ?? previous?.status ?? "UNKNOWN"),
        createdAt: latestPlacementAt(test) ?? realDate(campaignId, previous?.createdAt),
        runNumber: test.current_test_run_no ?? previous?.runNumber,
        ...overallFromTest(test),
        providers: previous?.providers ? [...previous.providers] : [],
        googleInboxPercent: previous?.googleInboxPercent,
        microsoftInboxPercent: previous?.microsoftInboxPercent,
      });
    }

    return [...byId.values()]
      .sort((a, b) => {
        const byIdOrder = numericTestId(b.id) - numericTestId(a.id);
        if (byIdOrder !== 0) return byIdOrder;
        return String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
      })
      .slice(0, 80);
  }

  /**
   * Read a couple of catalog pages from the saved offset. Newest pages are
   * pod-control tests with no campaign id. Walking eight pages from offset 0
   * on every open 429'd before those Auto tests were reached, and the next
   * open started over. A short page ends the walk. A 429 keeps the offset.
   */
  private async listNewestTests(
    isLive: (test: SpamTestSummary) => boolean,
    errors: string[],
    force: boolean,
    startOffset: number,
  ): Promise<{
    tests: SpamTestSummary[];
    truncated: boolean;
    exhausted: boolean;
    nextOffset: number;
  }> {
    const all: SpamTestSummary[] = [];
    let offset = Math.max(0, Math.floor(startOffset));
    const gapMs = process.env.NODE_TEST_CONTEXT ? 0 : 250;
    const sorted = () =>
      all.sort((a, b) =>
        String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
      );
    for (let page = 0; page < OPS_PLACEMENT_LIST_PAGES_PER_PASS; page += 1) {
      let raw: unknown;
      try {
        raw = await this.smartDelivery.listTests(
          {
            limit: OPS_PLACEMENT_LIST_PAGE,
            offset,
          },
          { retries: OPS_PLACEMENT_LIST_RETRIES },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isRateLimitNoise(message)) {
          this.rateLimitedUntil = Date.now() + this.rateLimitCooldownMs;
        }
        if (force || !all.length) {
          errors.push(humanizeAlertError(`listTests: ${message}`));
        }
        return {
          tests: sorted(),
          truncated: true,
          exhausted: false,
          nextOffset: offset,
        };
      }
      const rows = normalizeTestList(raw);
      all.push(...rows);
      if (rows.length < OPS_PLACEMENT_LIST_PAGE) {
        return {
          tests: sorted(),
          truncated: false,
          exhausted: true,
          nextOffset: 0,
        };
      }
      offset += rows.length;
      const live = all.filter(isLive).length;
      if (live >= OPS_PLACEMENT_REPORT_CAP) {
        return {
          tests: sorted(),
          truncated: false,
          exhausted: false,
          nextOffset: offset,
        };
      }
      if (gapMs && page + 1 < OPS_PLACEMENT_LIST_PAGES_PER_PASS) await sleep(gapMs);
    }
    return {
      tests: sorted(),
      truncated: false,
      exhausted: false,
      nextOffset: offset,
    };
  }
}

/** `Auto: ${campaignName}` plus an optional ` (i/n)` batch suffix. */
function autoPlacementCampaignName(
  testName: string | undefined | null,
): string | undefined {
  const match = /^auto:\s*(.+)$/i.exec(String(testName ?? "").trim());
  if (!match) return undefined;
  const name = match[1].replace(/\s+\(\d+\/\d+\)\s*$/, "").trim();
  return name || undefined;
}

/**
 * The report list omits campaign_id. Recurring tests are named after the
 * campaign, which is how an unlinked Auto test joins the board.
 */
function campaignIdFromAutoName(
  testName: string | undefined | null,
  liveById: Map<number, { name: string }>,
): number | undefined {
  const extracted = autoPlacementCampaignName(testName);
  if (!extracted) return undefined;
  const needle = extracted.toLowerCase();
  const hits: number[] = [];
  for (const [id, live] of liveById) {
    if (String(live.name ?? "").trim().toLowerCase() === needle) hits.push(id);
  }
  return hits.length === 1 ? hits[0] : undefined;
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
  const campaignId =
    resolveCampaignId(mapped?.campaignId, test) ??
    campaignIdFromAutoName(test.test_name, opts.liveById);
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

function placementBoardSignature(rows: PlacementResultRow[]): string {
  return rows
    .map((row) =>
      [
        row.id,
        row.campaignId ?? "",
        row.createdAt ?? "",
        row.runNumber ?? "",
        row.status,
        row.inboxPercent ?? "",
        row.spamPercent ?? "",
        row.totalSeeds ?? "",
        row.googleInboxPercent ?? "",
        row.microsoftInboxPercent ?? "",
      ].join(":"),
    )
    .join("|");
}

/**
 * Keep a fuller board when a truncated catalog would shrink it. Still save
 * when the current test id replaced an older one, or a last-run date moved,
 * even if the scored count did not grow.
 */
function shouldPersistPlacement(
  previous: PlacementResults | null,
  next: PlacementResults,
): boolean {
  if (!next.rows.length) return false;
  if (!previous?.rows.length) return true;
  if (next.complete) return true;
  const prevScored = previous.rows.filter((row) => placementRowHasResult(row)).length;
  const nextScored = next.rows.filter((row) => placementRowHasResult(row)).length;
  if (next.rows.length > previous.rows.length) return true;
  if (nextScored > prevScored) return true;
  if (next.rows.length < previous.rows.length && nextScored <= prevScored) {
    const nextByCampaign = new Map<number, string>();
    for (const row of next.rows) {
      if (row.campaignId != null) nextByCampaign.set(row.campaignId, row.id);
    }
    const droppedCurrent = previous.rows.some((row) => {
      if (row.campaignId == null) {
        return !next.rows.some((item) => item.id === row.id);
      }
      const winner = nextByCampaign.get(row.campaignId);
      if (!winner) return true;
      return numericTestId(row.id) > numericTestId(winner);
    });
    if (droppedCurrent) return false;
  }
  if ((previous.listOffset ?? 0) !== (next.listOffset ?? 0)) return true;
  return placementBoardSignature(next.rows) !== placementBoardSignature(previous.rows);
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
  applyProviderTotals(row, report);
}

/** List rows carry the overall counts. Provider reports do too, and the catalog is often skipped. */
function applyProviderTotals(
  row: PlacementResultRow,
  report: { result?: ProviderwiseRow[] },
): void {
  if (
    typeof row.inboxPercent === "number" &&
    typeof row.spamPercent === "number" &&
    row.totalSeeds > 0
  ) {
    return;
  }
  let inbox = 0;
  let spam = 0;
  let tab = 0;
  let seeds = 0;
  let counted = false;
  for (const provider of report.result ?? []) {
    const total =
      (typeof provider.adjusted_total_email_count === "number" &&
      provider.adjusted_total_email_count > 0
        ? provider.adjusted_total_email_count
        : undefined) ??
      (typeof provider.total_email_count === "number" &&
      provider.total_email_count > 0
        ? provider.total_email_count
        : undefined) ??
      (typeof provider.mailbox_count === "number" && provider.mailbox_count > 0
        ? provider.mailbox_count
        : undefined);
    if (typeof provider.inbox_count !== "number" || typeof total !== "number") {
      continue;
    }
    counted = true;
    inbox += provider.inbox_count;
    spam += typeof provider.spam_count === "number" ? provider.spam_count : 0;
    tab += typeof provider.tab_count === "number" ? provider.tab_count : 0;
    seeds += total;
  }
  if (!counted || seeds <= 0) return;
  row.inboxPercent = (inbox / seeds) * 100;
  row.spamPercent = (spam / seeds) * 100;
  row.tabPercent = (tab / seeds) * 100;
  row.totalSeeds = seeds;
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
