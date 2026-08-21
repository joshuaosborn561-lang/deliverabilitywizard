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

export type PoolProvisionPhase =
  | "idle"
  | "awaiting_ns"
  | "buying"
  | "awaiting_mailboxes"
  | "awaiting_sequencer"
  | "exporting"
  | "awaiting_export"
  | "importing_state"
  | "warming"
  | "ready"
  | "failed";

export interface PoolProvisionState {
  phase: PoolProvisionPhase;
  lastCheckedAt?: string;
  lastMessage?: string;
  lastError?: string;
  nsMatched?: number;
  nsTotal?: number;
  mailboxOrdered?: number;
  mailboxActive?: number;
  sequencerUid?: string;
  warmupStartedAt?: string;
  completedAt?: string;
}

export interface PoolMailboxRecord {
  email: string;
  domain: string;
  platform: "GOOGLE" | "MICROSOFT";
  /** Smartlead account id once imported */
  smartleadAccountId?: number;
  firstName: string;
  lastName: string;
  /** Hand-bought fleet that completed warmup before this app managed it. */
  prewarmed?: boolean;
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

export interface OpsAuditRecord {
  id: string;
  at: string;
  actor: string;
  role: "owner" | "operator";
  action: string;
  target?: string;
  outcome: "success" | "denied" | "error";
  detail?: string;
}

export interface FleetSummarySnapshot {
  generatedAt: string;
  totalMailboxes: number;
  sendingMailboxes: number;
  activeCampaigns: number;
  disconnectedMailboxes: number;
}

export interface PendingResumeRecord {
  campaignId: number;
  campaignName?: string;
  pausedAt: string;
  /** Why the protective pause happened (warmup gate, remediation, …). */
  reason: string;
}

export interface AppState {
  version: 1;
  lastScanAt: string | null;
  lastMonitorAt: string | null;
  lastRemediationAt: string | null;
  lastReconnectAt: string | null;
  lastWarmupGateAt: string | null;
  lastHealthAt: string | null;
  lastMailboxSettingsAt: string | null;
  testedCampaigns: Record<string, TestedCampaignRecord>;
  /** Dedupe keys for Slack alerts already sent */
  alertedKeys: Record<string, string>;
  /** Dedupe keys for remediation actions already taken */
  remediatedKeys: Record<string, string>;
  /** Inboxes held off campaigns until holdUntil (ISO date or datetime) */
  heldInboxes: Record<string, HeldInboxRecord>;
  /** D39 — separate placement tests for held/pulled mailboxes */
  heldPlacementTests: Record<string, HeldPlacementTestRecord>;
  /** D41 — client inboxes in their off-week (removed from live campaigns) */
  restingInboxes: Record<string, RestingInboxRecord>;
  /** D41 — separate placement tests for resting (off-week) client inboxes */
  restPlacementTests: Record<string, HeldPlacementTestRecord>;
  /** Generic recovery-pool mailboxes (client-agnostic) */
  poolMailboxes: Record<string, PoolMailboxRecord>;
  /** Active original↔pool swaps */
  activeSwaps: Record<string, ActiveSwapRecord>;
  /** Per-client monthly domain $ / mailbox caps (key = client id or name) */
  clientMonthlyUsage: Record<string, MonthlyUsageBucket>;
  /** Self-advancing pool provisioning pipeline */
  poolProvision: PoolProvisionState;
  /** Pending/decided real-money spend approvals (key = spend id) */
  spendApprovals: Record<string, SpendApprovalRecord>;
  /** Human operations performed through the authenticated /ops console. */
  opsAudit: OpsAuditRecord[];
  /** Last successful Smartlead fleet census, used when live reads are throttled. */
  fleetSummary: FleetSummarySnapshot | null;
  /**
   * Durable Cursor Cloud Agent id per Ops username so freeform chat can
   * continue the same Grok conversation across messages.
   */
  opsCursorAgents: Record<string, string>;
  /**
   * Fingerprints of recurring runtime failures the auto bug remediator is
   * watching or has already handed to a Cursor agent (D21).
   */
  bugRemediations: Record<string, BugRemediationRecord>;
  /**
   * Campaigns paused protectively (last-account remove, etc.) that should be
   * auto-resumed once staffed again (D25).
   */
  pendingResumes: Record<string, PendingResumeRecord>;
}

export interface BugRemediationRecord {
  fingerprint: string;
  failureClass: string;
  summary: string;
  source: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastError?: string;
  lastTriggeredAt?: string;
  agentId?: string;
  agentUrl?: string;
  runId?: string;
  prUrl?: string;
  status: "watching" | "triggered" | "pr_open" | "resolved" | "ignored";
}

export interface SpendApprovalRecord {
  id: string;
  /** Stable logical request key; cycles get unique ids after consumption. */
  requestKey?: string;
  kind: string;
  description: string;
  detail: Record<string, unknown>;
  requestedAt: string;
  status: "pending" | "approved" | "denied" | "consumed";
  decidedAt?: string;
  decidedBy?: string;
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

/** D41 — client inbox resting off live campaigns for its off-week. */
export interface RestingInboxRecord {
  accountId: number;
  email: string;
  clientId: string;
  cohort: "A" | "B";
  restingSince: string;
  removedFromCampaigns: number[];
  lastSameEspInbox: number | null;
}

/** D39 — SmartDelivery test covering held/pulled mailboxes (off campaigns). */
export interface HeldPlacementTestRecord {
  testId: string;
  emails: string[];
  /** Campaign id used only as the sequence shell — senders are not re-attached. */
  campaignId: number;
  createdAt: string;
}

const EMPTY_POOL_PROVISION: PoolProvisionState = {
  phase: "idle",
};

const EMPTY_STATE: AppState = {
  version: 1,
  lastScanAt: null,
  lastMonitorAt: null,
  lastRemediationAt: null,
  lastReconnectAt: null,
  lastWarmupGateAt: null,
  lastHealthAt: null,
  lastMailboxSettingsAt: null,
  testedCampaigns: {},
  alertedKeys: {},
  remediatedKeys: {},
  heldInboxes: {},
  heldPlacementTests: {},
  restingInboxes: {},
  restPlacementTests: {},
  poolMailboxes: {},
  activeSwaps: {},
  clientMonthlyUsage: {},
  poolProvision: { ...EMPTY_POOL_PROVISION },
  spendApprovals: {},
  opsAudit: [],
  fleetSummary: null,
  opsCursorAgents: {},
  bugRemediations: {},
  pendingResumes: {},
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
        heldPlacementTests: parsed.heldPlacementTests ?? {},
        restingInboxes: parsed.restingInboxes ?? {},
        restPlacementTests: parsed.restPlacementTests ?? {},
        poolMailboxes: parsed.poolMailboxes ?? {},
        activeSwaps: parsed.activeSwaps ?? {},
        clientMonthlyUsage: parsed.clientMonthlyUsage ?? {},
        poolProvision: {
          ...EMPTY_POOL_PROVISION,
          ...(parsed.poolProvision ?? {}),
        },
        spendApprovals: parsed.spendApprovals ?? {},
        opsAudit: parsed.opsAudit ?? [],
        fleetSummary: parsed.fleetSummary ?? null,
        opsCursorAgents: parsed.opsCursorAgents ?? {},
        bugRemediations: parsed.bugRemediations ?? {},
        pendingResumes: parsed.pendingResumes ?? {},
        lastHealthAt: parsed.lastHealthAt ?? null,
        lastMailboxSettingsAt: parsed.lastMailboxSettingsAt ?? null,
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

  hasRecentAlert(
    key: string,
    cooldownMs: number,
    now = new Date(),
  ): boolean {
    const markedAt = this.state.alertedKeys[key];
    if (!markedAt) return false;
    const timestamp = Date.parse(markedAt);
    if (!Number.isFinite(timestamp)) return false;
    return now.getTime() - timestamp < cooldownMs;
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

  clearRemediation(key: string): void {
    delete this.state.remediatedKeys[key];
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

  markHeldPlacementTest(record: HeldPlacementTestRecord): void {
    this.state.heldPlacementTests[record.testId] = record;
  }

  getHeldPlacementTest(testId: string): HeldPlacementTestRecord | undefined {
    return this.state.heldPlacementTests[testId];
  }

  listHeldPlacementTests(): HeldPlacementTestRecord[] {
    return Object.values(this.state.heldPlacementTests);
  }

  clearHeldPlacementTest(testId: string): void {
    delete this.state.heldPlacementTests[testId];
  }

  markRestingInbox(record: RestingInboxRecord): void {
    this.state.restingInboxes[record.email.toLowerCase()] = record;
  }

  getRestingInbox(email: string): RestingInboxRecord | undefined {
    return this.state.restingInboxes[email.toLowerCase()];
  }

  listRestingInboxes(): RestingInboxRecord[] {
    return Object.values(this.state.restingInboxes);
  }

  clearRestingInbox(email: string): void {
    delete this.state.restingInboxes[email.toLowerCase()];
  }

  markRestPlacementTest(record: HeldPlacementTestRecord): void {
    this.state.restPlacementTests[record.testId] = record;
  }

  getRestPlacementTest(testId: string): HeldPlacementTestRecord | undefined {
    return this.state.restPlacementTests[testId];
  }

  listRestPlacementTests(): HeldPlacementTestRecord[] {
    return Object.values(this.state.restPlacementTests);
  }

  clearRestPlacementTest(testId: string): void {
    delete this.state.restPlacementTests[testId];
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

  getSpendApproval(id: string): SpendApprovalRecord | undefined {
    return this.state.spendApprovals[id];
  }

  getLatestSpendApprovalForRequest(
    requestKey: string,
  ): SpendApprovalRecord | undefined {
    return Object.values(this.state.spendApprovals)
      .filter((record) => (record.requestKey ?? record.id) === requestKey)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  }

  upsertSpendApproval(record: SpendApprovalRecord): void {
    this.state.spendApprovals[record.id] = record;
  }

  listSpendApprovals(): SpendApprovalRecord[] {
    return Object.values(this.state.spendApprovals);
  }

  /** Returns the updated record, or undefined if no pending/known approval matches `id`. */
  decideSpendApproval(
    id: string,
    status: "approved" | "denied",
    decidedBy?: string,
  ): SpendApprovalRecord | undefined {
    const record = this.state.spendApprovals[id];
    if (!record || record.status !== "pending") return undefined;
    record.status = status;
    record.decidedAt = new Date().toISOString();
    if (decidedBy) record.decidedBy = decidedBy;
    return record;
  }

  /** Mark an approved request as spent; consumed approvals are never reusable. */
  consumeSpendApproval(id: string): SpendApprovalRecord | undefined {
    const record = this.state.spendApprovals[id];
    if (!record || record.status !== "approved") return undefined;
    record.status = "consumed";
    record.decidedAt = new Date().toISOString();
    return record;
  }

  appendOpsAudit(record: OpsAuditRecord): void {
    this.state.opsAudit.push(record);
    // Keep state bounded while retaining enough history for daily operations.
    if (this.state.opsAudit.length > 500) {
      this.state.opsAudit.splice(0, this.state.opsAudit.length - 500);
    }
  }

  listOpsAudit(limit = 100): OpsAuditRecord[] {
    return this.state.opsAudit.slice(-Math.max(0, limit)).reverse();
  }

  getOpsCursorAgentId(username: string): string | undefined {
    const key = username.trim().toLowerCase();
    const id = this.state.opsCursorAgents[key];
    return id || undefined;
  }

  setOpsCursorAgentId(username: string, agentId: string): void {
    const key = username.trim().toLowerCase();
    this.state.opsCursorAgents[key] = agentId;
  }

  getBugRemediation(fingerprint: string): BugRemediationRecord | undefined {
    return this.state.bugRemediations[fingerprint];
  }

  bumpBugRemediation(input: {
    fingerprint: string;
    failureClass: string;
    summary: string;
    source: string;
    lastError?: string;
    at: string;
  }): BugRemediationRecord {
    const existing = this.state.bugRemediations[input.fingerprint];
    if (!existing) {
      const created: BugRemediationRecord = {
        fingerprint: input.fingerprint,
        failureClass: input.failureClass,
        summary: input.summary,
        source: input.source,
        count: 1,
        firstSeenAt: input.at,
        lastSeenAt: input.at,
        lastError: input.lastError,
        status: "watching",
      };
      this.state.bugRemediations[input.fingerprint] = created;
      return created;
    }
    existing.count += 1;
    existing.lastSeenAt = input.at;
    existing.summary = input.summary;
    existing.source = input.source;
    existing.failureClass = input.failureClass;
    if (input.lastError) existing.lastError = input.lastError;
    if (existing.status === "resolved") existing.status = "watching";
    return existing;
  }

  markBugRemediation(
    fingerprint: string,
    patch: Partial<BugRemediationRecord>,
  ): BugRemediationRecord | undefined {
    const existing = this.state.bugRemediations[fingerprint];
    if (!existing) return undefined;
    Object.assign(existing, patch);
    return existing;
  }

  clearOpsCursorAgentId(username: string): void {
    const key = username.trim().toLowerCase();
    delete this.state.opsCursorAgents[key];
  }

  setFleetSummary(summary: FleetSummarySnapshot): void {
    this.state.fleetSummary = summary;
  }

  getFleetSummary(): FleetSummarySnapshot | null {
    return this.state.fleetSummary;
  }

  getPoolProvision(): PoolProvisionState {
    return this.state.poolProvision;
  }

  setPoolProvision(patch: Partial<PoolProvisionState>): void {
    this.state.poolProvision = {
      ...this.state.poolProvision,
      ...patch,
    };
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
      (m) =>
        m.status === "available" &&
        m.platform === platform &&
        !this.getRestingInbox(m.email),
    );
  }

  /**
   * A pool mailbox the top-up may take.
   *
   * Includes generics already serving a campaign: they are legitimate supply
   * as long as releasing one leaves the donor above its floor, which only the
   * caller can judge. Warming mailboxes are never returned — a mailbox that
   * has not served its warmup is not supply at any floor. Resting generics
   * (D42) are not supply either.
   */
  findReassignablePoolMailbox(
    platforms: Array<"GOOGLE" | "MICROSOFT">,
    canTake: (email: string) => boolean,
  ): PoolMailboxRecord | undefined {
    for (const platform of platforms) {
      const match = Object.values(this.state.poolMailboxes).find(
        (m) =>
          m.platform === platform &&
          (m.status === "available" || m.status === "assigned") &&
          !this.getRestingInbox(m.email) &&
          canTake(m.email),
      );
      if (match) return match;
    }
    return undefined;
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

  setLastReconnectAt(iso: string): void {
    this.state.lastReconnectAt = iso;
  }

  setLastWarmupGateAt(iso: string): void {
    this.state.lastWarmupGateAt = iso;
  }

  setLastHealthAt(iso: string): void {
    this.state.lastHealthAt = iso;
  }

  setLastMailboxSettingsAt(iso: string): void {
    this.state.lastMailboxSettingsAt = iso;
  }

  markPendingResume(record: PendingResumeRecord): void {
    this.state.pendingResumes[String(record.campaignId)] = record;
  }

  hasPendingResume(campaignId: number): boolean {
    return Boolean(this.state.pendingResumes[String(campaignId)]);
  }

  getPendingResume(campaignId: number): PendingResumeRecord | undefined {
    return this.state.pendingResumes[String(campaignId)];
  }

  listPendingResumes(): PendingResumeRecord[] {
    return Object.values(this.state.pendingResumes);
  }

  clearPendingResume(campaignId: number): void {
    delete this.state.pendingResumes[String(campaignId)];
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
