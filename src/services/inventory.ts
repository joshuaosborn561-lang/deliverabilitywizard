import type {
  SmartleadAccountWithCampaigns,
  SmartleadClient,
  SmartleadClientRecord,
} from "../clients/smartlead.js";
import { numericClientId } from "../lib/campaignClient.js";
import type { SmartleadCampaign } from "../types/index.js";

/**
 * D84 — one Smartlead inventory fetch per health pass.
 *
 * Before this, every stage of the 15-minute loop (rest, client tag,
 * one-client, campaign check, fan-out, top-up, mailbox gap) refetched
 * campaigns + ~12 paginated account pages + clients on its own. Eight
 * refetches per pass plus the 10-minute bounce loop exhausted Smartlead's
 * rate limit, stages died on 429 with a swallowed console.warn, and the
 * "15-minute" cadence quietly became fiction. One snapshot per pass is the
 * fix, not a cache for its own sake.
 *
 * Mutating stages keep the snapshot honest with recordMembership /
 * dropMembership instead of refetching mid-pass.
 */
export interface InventorySnapshot {
  campaigns: SmartleadCampaign[];
  accounts: SmartleadAccountWithCampaigns[];
  clients: SmartleadClientRecord[];
  fetchedAt: number;
}

/** Smartlead sometimes serializes client_id as a string on list payloads. */
export function coerceInventoryClientIds(snapshot: InventorySnapshot): void {
  for (const campaign of snapshot.campaigns) {
    const id = numericClientId(campaign.client_id);
    campaign.client_id = id;
  }
  for (const account of snapshot.accounts) {
    const id = numericClientId(account.client_id);
    account.client_id = id;
  }
}

export const INVENTORY_429_ATTEMPTS = 3;
export const INVENTORY_429_DELAY_MS = 30_000;

export function isSmartleadRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate limit/i.test(message);
}

export async function fetchInventory(
  smartlead: Pick<SmartleadClient, "listCampaigns" | "listAllEmailAccounts"> &
    Partial<Pick<SmartleadClient, "listClients">>,
  opts?: {
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<InventorySnapshot> {
  const attempts = INVENTORY_429_ATTEMPTS;
  const delayMs = opts?.retryDelayMs ?? INVENTORY_429_DELAY_MS;
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const [campaigns, accounts, clients] = await Promise.all([
        smartlead.listCampaigns(),
        smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
        typeof smartlead.listClients === "function"
          ? smartlead.listClients().catch(() => [] as SmartleadClientRecord[])
          : Promise.resolve([] as SmartleadClientRecord[]),
      ]);
      const snapshot: InventorySnapshot = {
        campaigns: campaigns as SmartleadCampaign[],
        accounts: accounts as SmartleadAccountWithCampaigns[],
        clients,
        fetchedAt: Date.now(),
      };
      coerceInventoryClientIds(snapshot);
      return snapshot;
    } catch (error) {
      lastError = error;
      if (!isSmartleadRateLimit(error) || attempt === attempts) {
        throw error;
      }
      console.warn(
        `[inventory] ${error instanceof Error ? error.message : String(error)} — retry ${attempt}/${attempts - 1} in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/** A fetch is suspected partial when the account book shrinks this much. */
export const PARTIAL_READ_RATIO = 0.8;
/** Minimum spacing between fetch attempts while Smartlead is unhappy. */
export const BOOK_RETRY_SPACING_MS = 2 * 60 * 1000;

/**
 * D132 — ONE Smartlead account book for the whole machine.
 *
 * The health pass fetches fresh every 15 minutes (D84) and publishes here;
 * the hourly campaign check, the 6-hour campaign audit, and the /ops board
 * read the shared snapshot instead of refetching the whole account book
 * each on their own — that split-brain fetching is what 429'd the board
 * and starved mailbox-settings-full.
 *
 * The book also refuses to believe a partial read: Smartlead pagination
 * that quietly drops pages made findings oscillate (under_warmed jumping
 * 0→17→0 on 2026-08-26). A fetch whose account count falls below 80% of
 * the accepted book is held as a candidate and the accepted book keeps
 * serving; only a second consecutive shrunken fetch is believed (mailboxes
 * really can be deleted in bulk — reality gets two reads to prove itself).
 * A fetch that throws serves the accepted book as carry-over, loudly.
 */
export class InventoryBook {
  private accepted: InventorySnapshot | null = null;
  private shrunkenStreak = 0;
  private lastAttemptAt = 0;
  private inFlight: Promise<InventorySnapshot> | null = null;

  constructor(
    private readonly smartlead: Parameters<typeof fetchInventory>[0],
    private readonly freshMs: number = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The accepted snapshot if it is at most `maxAgeMs` old, else a fetch. */
  async get(maxAgeMs: number = this.freshMs): Promise<InventorySnapshot> {
    if (this.accepted && this.now() - this.accepted.fetchedAt <= maxAgeMs) {
      return this.accepted;
    }
    return this.fetchFresh();
  }

  /**
   * Fetch through the acceptance gate and return the accepted book — the
   * fresh snapshot normally; the carried-over one when the fetch was
   * partial or failed. The health pass's per-pass fetch routes through
   * here so every consumer shares one truth.
   */
  async fetchFresh(): Promise<InventorySnapshot> {
    if (this.inFlight) return this.inFlight;
    if (
      this.accepted &&
      this.now() - this.lastAttemptAt < BOOK_RETRY_SPACING_MS
    ) {
      return this.accepted;
    }
    this.lastAttemptAt = this.now();
    this.inFlight = (async () => {
      let snapshot: InventorySnapshot;
      try {
        snapshot = await fetchInventory(this.smartlead);
      } catch (error) {
        if (!this.accepted) throw error;
        console.warn(
          `[inventory] fetch failed — carrying over the accepted book from ${new Date(this.accepted.fetchedAt).toISOString()} (${this.accepted.accounts.length} accounts): ${error instanceof Error ? error.message : String(error)}`,
        );
        return this.accepted;
      }
      return this.publish(snapshot);
    })();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /** Run a snapshot through the partial-read gate; returns the accepted book. */
  publish(snapshot: InventorySnapshot): InventorySnapshot {
    // Freshness is judged on the book's own clock (injectable in tests).
    snapshot.fetchedAt = this.now();
    const prior = this.accepted;
    if (
      prior &&
      snapshot.accounts.length < prior.accounts.length * PARTIAL_READ_RATIO
    ) {
      this.shrunkenStreak += 1;
      if (this.shrunkenStreak < 2) {
        console.warn(
          `[inventory] suspected partial read (${snapshot.accounts.length} accounts vs ${prior.accounts.length} accepted) — keeping the accepted book; a second shrunken read will be believed`,
        );
        return prior;
      }
      console.warn(
        `[inventory] account book really shrank (${prior.accounts.length} → ${snapshot.accounts.length}) — two consecutive reads agree; accepting`,
      );
    }
    this.shrunkenStreak = 0;
    this.accepted = snapshot;
    return snapshot;
  }
}

/** Keep the in-pass snapshot truthful after a successful campaign add. */
export function recordMembership(
  account: SmartleadAccountWithCampaigns,
  campaignId: number,
): void {
  const ids = Array.isArray(account.campaign_ids) ? account.campaign_ids : [];
  if (!ids.includes(campaignId)) {
    account.campaign_ids = [...ids, campaignId];
  }
}

/** Keep the in-pass snapshot truthful after a successful campaign remove. */
export function dropMembership(
  account: SmartleadAccountWithCampaigns,
  campaignId: number,
): void {
  if (Array.isArray(account.campaign_ids)) {
    account.campaign_ids = account.campaign_ids.filter((id) => id !== campaignId);
  }
  if (Array.isArray(account.campaigns)) {
    account.campaigns = account.campaigns.filter(
      (row) => (row.id ?? row.campaign_id) !== campaignId,
    );
  }
}
