import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
} from "../clients/smartlead.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
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
}

export interface FleetSummary {
  generatedAt: string;
  totalMailboxes: number;
  sendingMailboxes: number;
  mailboxesInRecovery: number;
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
    private readonly smartlead: SmartleadClient,
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
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<PlacementResults> {
    const errors: string[] = [];
    const raw = await this.smartDelivery.listTests({});
    const listed = normalizeTestList(raw).sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    );

    const liveById = new Map<number, { name: string }>();
    let campaignsLoaded = false;
    try {
      const campaigns = await this.smartlead.listCampaigns();
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
        `campaigns: ${error instanceof Error ? error.message : String(error)}`,
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

    const tests = listed
      .filter((test) => {
        if (titleHasCanaryCopyPhrase(test.test_name)) return false;
        const id = testIdOf(test);
        const mapped = id ? campaignByTest.get(id) : undefined;
        const campaignId = resolveCampaignId(mapped?.campaignId, test);
        if (campaignId == null) return false;
        if (campaignsLoaded) {
          const live = liveById.get(campaignId);
          if (!live) return false;
          if (titleHasCanaryCopyPhrase(mapped?.campaignName, live.name)) {
            return false;
          }
        } else if (titleHasCanaryCopyPhrase(mapped?.campaignName)) {
          return false;
        }
        return true;
      })
      // Match the production monitor's rate-limit ceiling — after the
      // canary-copy tests are gone, so live senders still get reports.
      .slice(0, 40);

    const rows: PlacementResultRow[] = new Array(tests.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < tests.length) {
        const index = cursor++;
        const test = tests[index]!;
        const id = testIdOf(test);
        if (!id) continue;
        const mapped = campaignByTest.get(id);
        const campaignId = resolveCampaignId(mapped?.campaignId, test);
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
          providers: [],
        };
        try {
          const report = await this.smartDelivery.getProviderwiseReport(id);
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
              (
                provider,
              ): provider is { name: string; inboxPercent: number } =>
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
        } catch (error) {
          errors.push(
            `test ${id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        rows[index] = row;
        await sleep(100);
      }
    };
    // SmartDelivery rate limits provider reports aggressively; sequential
    // reads keep the employee refresh from competing with the monitor cron.
    await worker();
    const value = {
      generatedAt: new Date().toISOString(),
      rows: rows.filter(Boolean),
      errors,
    };
    this.cache = { expiresAt: Date.now() + this.cacheMs, value };
    return value;
  }
}

export class FleetSummaryService {
  private cache: { expiresAt: number; value: FleetSummary } | undefined;
  private inFlight: Promise<FleetSummary> | null = null;
  private readonly forceRefreshFloorMs = 15 * 1000;

  constructor(
    private readonly smartlead: SmartleadClient,
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
      mailboxesInRecovery: this.state.listHeldInboxes().length,
    };
  }

  private async load(): Promise<FleetSummary> {
    const [campaigns, accounts] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
    ]);
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
      mailboxesInRecovery: this.state.listHeldInboxes().length,
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
