import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  currentUtcMonth,
  emptyMonthlyUsage,
  normalizeMonthlyUsage,
  type MonthlyUsageBucket,
} from "../lib/monthlyCaps.js";

export interface TestedCampaignRecord {
  campaignId: number;
  campaignName: string;
  testedAt: string;
  testIds: string[];
  mailboxCount: number;
  testsCreated: number;
}

export type PoolMailboxStatus =
  | "warming"
  | "available"
  | "assigned"
  | "provisioning";

export interface PoolMailboxRecord {
  email: string;
  domain: string;
  platform: "GOOGLE" | "MICROSOFT";
  /** Smartlead account id once imported */
  smartleadAccountId?: number;
  firstName: string;
  lastName: string;
  status: PoolMailboxRecordStatus;
  warmedAt?: string;
  availableAt?: string;
  assignedToEmail?: string;
  assignedClientId?: number | null;
  assignedClientName?: string;
  assignedAt?: string;
}

type PoolMailboxRecordStatus = PoolMailboxStatus;

export interface ActiveSwapRecord {
  originalEmail: string;
  originalAccountId: number;
  poolEmail: string;
  poolAccountId: number;
  clientId: number | null;
  clientName: string;
  campaignIds: number[];
  swappedAt: string;
  originalEsp?: string;
  poolPlatform: "GOOGLE" | "MICROSOFT";
}

export interface AppState {
  version: 1;
  lastScanAt: string | null;
  lastMonitorAt: string | null;
  lastRemediationAt: string | null;
  testedCampaigns: Record<string, TestedCampaignRecord>;
  /** Dedupe keys for Slack alerts already sent */
  alertedKeys: Record<string, string>;
  /** Dedupe keys for remediation actions already taken */
  remediatedKeys: Record<string, string>;
  /** Inboxes held off campaigns until holdUntil (ISO date or datetime) */
  heldInboxes: Record<string, HeldInboxRecord>;
  /** Generic recovery-pool mailboxes (client-agnostic) */
  poolMailboxes: Record<string, PoolMailboxRecord>;
  /** Active original↔pool swaps */
  activeSwaps: Record<string, ActiveSwapRecord>;
  /** Per-client monthly domain $ / mailbox caps (key = client id or name) */
  clientMonthlyUsage: Record<string, MonthlyUsageBucket>;
}

export interface HeldInboxRecord {
  accountId: number;
  email: string;
  heldAt: string;
  holdUntil: string;
  tagName: string;
  inboxRate?: number;
  inboxRateAll?: number;
  inboxRateSameEsp?: number;
  scoredSameEsp?: boolean;
  removedFromCampaigns?: number[];
  /** When set, a pool generic is covering these campaigns */
  swappedWithPoolEmail?: string;
}

const EMPTY_STATE: AppState = {
  version: 1,
  lastScanAt: null,
  lastMonitorAt: null,
  lastRemediationAt: null,
  testedCampaigns: {},
  alertedKeys: {},
  remediatedKeys: {},
  heldInboxes: {},
  poolMailboxes: {},
  activeSwaps: {},
  clientMonthlyUsage: {},
};

export class StateStore {
  private state: AppState = structuredClone(EMPTY_STATE);
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AppState;
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        testedCampaigns: parsed.testedCampaigns ?? {},
        alertedKeys: parsed.alertedKeys ?? {},
        remediatedKeys: parsed.remediatedKeys ?? {},
        heldInboxes: parsed.heldInboxes ?? {},
        poolMailboxes: parsed.poolMailboxes ?? {},
        activeSwaps: parsed.activeSwaps ?? {},
        clientMonthlyUsage: parsed.clientMonthlyUsage ?? {},
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(`[state] Failed to read ${this.filePath}:`, error);
      }
      this.state = structuredClone(EMPTY_STATE);
    }
    this.loaded = true;
    return this.state;
  }

  get(): AppState {
    if (!this.loaded) {
      throw new Error("StateStore.load() must be called before get()");
    }
    return this.state;
  }

  isCampaignTested(campaignId: number): boolean {
    return Boolean(this.state.testedCampaigns[String(campaignId)]);
  }

  markCampaignTested(record: TestedCampaignRecord): void {
    this.state.testedCampaigns[String(record.campaignId)] = record;
  }

  hasAlert(key: string): boolean {
    return Boolean(this.state.alertedKeys[key]);
  }

  markAlert(key: string): void {
    this.state.alertedKeys[key] = new Date().toISOString();
  }

  hasRemediation(key: string): boolean {
    return Boolean(this.state.remediatedKeys[key]);
  }

  markRemediation(key: string): void {
    this.state.remediatedKeys[key] = new Date().toISOString();
    this.state.lastRemediationAt = new Date().toISOString();
  }

  markHeldInbox(record: HeldInboxRecord): void {
    this.state.heldInboxes[record.email.toLowerCase()] = record;
  }

  getHeldInbox(email: string): HeldInboxRecord | undefined {
    return this.state.heldInboxes[email.toLowerCase()];
  }

  listHeldInboxes(): HeldInboxRecord[] {
    return Object.values(this.state.heldInboxes);
  }

  clearHeldInbox(email: string): void {
    delete this.state.heldInboxes[email.toLowerCase()];
  }

  clearInboxRemediation(email: string): void {
    delete this.state.remediatedKeys[`remediate-inbox:${email.toLowerCase()}`];
  }

  /** Drop inbox-recovery dedupe keys so a follow-up run can retry rate-limited work. */
  clearInboxRemediations(): number {
    let cleared = 0;
    for (const key of Object.keys(this.state.remediatedKeys)) {
      if (key.startsWith("remediate-inbox:")) {
        delete this.state.remediatedKeys[key];
        cleared += 1;
      }
    }
    return cleared;
  }

  upsertPoolMailbox(record: PoolMailboxRecord): void {
    this.state.poolMailboxes[record.email.toLowerCase()] = record;
  }

  getPoolMailbox(email: string): PoolMailboxRecord | undefined {
    return this.state.poolMailboxes[email.toLowerCase()];
  }

  listPoolMailboxes(): PoolMailboxRecord[] {
    return Object.values(this.state.poolMailboxes);
  }

  /**
   * Mark warming mailboxes as available once warmupDays have elapsed.
   */
  refreshPoolAvailability(warmupDays: number, now = new Date()): number {
    let flipped = 0;
    const ms = warmupDays * 24 * 60 * 60 * 1000;
    for (const row of Object.values(this.state.poolMailboxes)) {
      if (row.status !== "warming") continue;
      const start = row.warmedAt ? Date.parse(row.warmedAt) : NaN;
      if (!Number.isFinite(start)) continue;
      if (now.getTime() - start >= ms) {
        row.status = "available";
        row.availableAt = now.toISOString();
        flipped += 1;
      }
    }
    return flipped;
  }

  findAvailablePoolMailbox(
    platform: "GOOGLE" | "MICROSOFT",
  ): PoolMailboxRecord | undefined {
    return Object.values(this.state.poolMailboxes).find(
      (m) => m.status === "available" && m.platform === platform,
    );
  }

  markSwap(record: ActiveSwapRecord): void {
    this.state.activeSwaps[record.originalEmail.toLowerCase()] = record;
    const pool = this.state.poolMailboxes[record.poolEmail.toLowerCase()];
    if (pool) {
      pool.status = "assigned";
      pool.assignedToEmail = record.originalEmail.toLowerCase();
      pool.assignedClientId = record.clientId;
      pool.assignedClientName = record.clientName;
      pool.assignedAt = record.swappedAt;
    }
    const held = this.state.heldInboxes[record.originalEmail.toLowerCase()];
    if (held) held.swappedWithPoolEmail = record.poolEmail.toLowerCase();
  }

  getSwap(originalEmail: string): ActiveSwapRecord | undefined {
    return this.state.activeSwaps[originalEmail.toLowerCase()];
  }

  listActiveSwaps(): ActiveSwapRecord[] {
    return Object.values(this.state.activeSwaps);
  }

  clearSwap(originalEmail: string): void {
    const key = originalEmail.toLowerCase();
    const swap = this.state.activeSwaps[key];
    if (swap) {
      const pool = this.state.poolMailboxes[swap.poolEmail.toLowerCase()];
      if (pool) {
        pool.status = "available";
        pool.assignedToEmail = undefined;
        pool.assignedClientId = undefined;
        pool.assignedClientName = undefined;
        pool.assignedAt = undefined;
      }
      delete this.state.activeSwaps[key];
    }
    const held = this.state.heldInboxes[key];
    if (held) held.swappedWithPoolEmail = undefined;
  }

  clientUsageKey(clientId: number | null, clientName?: string): string {
    if (clientId != null) return `id:${clientId}`;
    return `name:${(clientName || "unassigned").toLowerCase()}`;
  }

  getClientMonthlyUsage(
    clientId: number | null,
    clientName?: string,
  ): MonthlyUsageBucket {
    const key = this.clientUsageKey(clientId, clientName);
    const normalized = normalizeMonthlyUsage(
      this.state.clientMonthlyUsage[key],
    );
    this.state.clientMonthlyUsage[key] = normalized;
    return normalized;
  }

  recordDomainSpend(
    clientId: number | null,
    clientName: string | undefined,
    usd: number,
  ): MonthlyUsageBucket {
    const usage = this.getClientMonthlyUsage(clientId, clientName);
    usage.domainSpendUsd += usd;
    this.state.clientMonthlyUsage[this.clientUsageKey(clientId, clientName)] =
      usage;
    return usage;
  }

  recordMailboxCreates(
    clientId: number | null,
    clientName: string | undefined,
    count: number,
  ): MonthlyUsageBucket {
    const usage = this.getClientMonthlyUsage(clientId, clientName);
    usage.mailboxesCreated += count;
    this.state.clientMonthlyUsage[this.clientUsageKey(clientId, clientName)] =
      usage;
    return usage;
  }

  setLastScanAt(iso: string): void {
    this.state.lastScanAt = iso;
  }

  setLastMonitorAt(iso: string): void {
    this.state.lastMonitorAt = iso;
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}

export { currentUtcMonth, emptyMonthlyUsage };
