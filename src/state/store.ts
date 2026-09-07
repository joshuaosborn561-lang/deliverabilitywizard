import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  currentUtcMonth,
  emptyMonthlyUsage,
  normalizeMonthlyUsage,
  type MonthlyUsageBucket,
} from "../lib/monthlyCaps.js";
import {
  isCopyCanaryFleetEmail,
  type CopyCanaryFleetRecord,
} from "../lib/copyCanaryFleet.js";
import {
  EMPTY_ISOLATION_STATE,
  normalizeIsolationState,
  type CopySuspectRecord,
  type PlacementScoreRecord,
  type IsolationActionRecord,
  type IsolationRunRecord,
  type IsolationState,
  type IsolationVariantRecord,
  type MailboxControlResultRecord,
  type PodControlRecord,
  type DomainControlHistoryRecord,
} from "./isolationState.js";
import type { DomainOwnerRecord } from "../lib/domainOwnership.js";
import { isRetryableReplacementBuy } from "../lib/buyResume.js";
import type { SuppressedTerm } from "../lib/suppressedTerms.js";
import {
  mergeAttachBlock,
  senderIsAttachBlocked,
  type AttachBlockRecord,
} from "../lib/attachBlock.js";
import type { CampaignCheckRecord } from "../lib/campaignCheck.js";
import type { GenericBackfillApproval } from "../lib/genericBackfill.js";

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
  /** D54 dedicated campaign-copy canary — never staffable, warmup stays off. */
  copyCanary?: boolean;
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

export interface StaffingShortRecord {
  campaignId: number;
  name: string;
  staffable: number;
  shortBy: number;
  status: string;
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
  /** Latest health short list — posted on the end-of-day brief (D64). */
  lastStaffingShort: StaffingShortRecord[];
  testedCampaigns: Record<string, TestedCampaignRecord>;
  /** Dedupe keys for Slack alerts already sent */
  alertedKeys: Record<string, string>;
  /** Dedupe keys for remediation actions already taken */
  remediatedKeys: Record<string, string>;
  /** Inboxes held off campaigns until holdUntil (ISO date or datetime) */
  heldInboxes: Record<string, HeldInboxRecord>;
  /** D41/D43 — client A/B resters and generics on the send-clock sit */
  restingInboxes: Record<string, RestingInboxRecord>;
  /** First time we saw a generic on a live campaign (send clock). */
  genericSendStartedAt: Record<string, string>;
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
  /** D107 — leftover Nieto / MSRS / Positive campaigns deleted. */
  oldClientTeardownAt: string | null;
  /** D48 — standing pod controls, isolation runs, suppressed terms. */
  isolation: IsolationState;
  /** D81 — first-seen campaign audit + hourly sweep records. */
  campaignChecks: Record<string, CampaignCheckRecord>;
  /** D81 — Josh Slack-approved generic backfill, per campaign. */
  genericBackfillApprovals: Record<string, GenericBackfillApproval>;
  domainAdvisories: DomainClientAdvisory[];
  /** D160 — leftover D142 Generic / POC client ids, stamped only to drain. */
  markerClients: { genericId?: number; pocId?: number };
  /** D147 — restarted bounce-paused campaigns whose incident leads are being re-queued. */
  bounceResurrectionJobs: Record<string, BounceResurrectionJob>;
  /** D147 — campaignId:email → when that lead was re-queued (once per lead per campaign). */
  resurrectedLeads: Record<string, string>;
  /** D143 — repeat gate pulls per accountId:campaignId (external re-add detector). */
  warmupGatePulls: Record<string, WarmupGatePullRecord>;
  /** D143 — last warmup re-enable write per accountId (skip the 84/pass rewrites). */
  warmupEnsuredAt: Record<string, string>;
  /**
   * D176 — domains / senders that must not be reattached after AS(42004),
   * sender_blocked, restricted, or bounce-isolation unlink. Keyed by domain.
   */
  attachBlocks: Record<string, AttachBlockRecord>;
  /** D140 — last classified bounce verdict per campaign (id key). */
  bounceVerdicts: Record<string, BounceVerdictRecord>;
  /** D90 — last lifetime bounce/sent reading per campaign for the 10-minute burst trip. */
  bounceSnapshots: Record<
    string,
    { bounced: number; sent: number; at: string; senderBlockHint?: string }
  >;
  /**
   * D128 — campaigns the D90 bounce loop paused (id → ISO). qa-unpause never
   * STARTs a stamped campaign; the stamp clears when a human STARTs it and
   * the loop sees it ACTIVE again. D148 retired the pause itself, so no new
   * stamps are written — this map only drains pre-D148 stamps.
   */
  bouncePausedCampaigns: Record<string, string>;
  /** D84 — per-stage watchdog: last success / failure per named loop. */
  stageHealth: Record<string, StageHealthRecord>;
  /** D149 — overdue stages currently paged to Slack (name → ISO paged-at). */
  stageAlertedAt: Record<string, string>;
  /**
   * D163 — last CANON-miss Slack incident per campaign (id → kind).
   * Same kind stays silent; a transition pages; recovery deletes the stamp.
   */
  canonMissAlerted: Record<string, string>;
  /**
   * D85 — zero connected unwarmed-canary mailboxes, reported once instead of
   * as a finding on every ACTIVE campaign. Null when the fleet has at least
   * one connected mailbox.
   */
  canaryFleetDown: CanaryFleetDownRecord | null;
}

/** D85 — the single fleet-level fact behind the old 48x canary_inactive. */
export interface CanaryFleetDownRecord {
  since: string;
  fleetSize: number;
}

/** D84 — watchdog record for one named stage of a scheduled loop. */
export interface StageHealthRecord {
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  /** D166 — why the last success was an idle tick, or null if work ran. */
  lastSkipReason?: string | null;
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

/** D41/D43 — mailbox resting off live campaigns. */
/** D140 — what the SMTP reasons said the last time a campaign's bounces were read. */
export interface BounceVerdictRecord {
  campaignId: number;
  at: string;
  dominant: string | null;
  summary: string;
  senderDomains: string[];
}

/** D136 — a sending domain whose client story needs a human. */
export interface DomainClientAdvisory {
  domain: string;
  kind: "split_clients" | "unmapped";
  note: string;
  at: string;
}

/** D148 — one parked sender-fault lead waiting for its remediation gate. */
export interface DeferredResurrectionLead {
  email: string;
  /** The lead's OWN NDR class — decides which remediation gate applies. */
  cls: string;
  /** Sending mailbox domain (the sender_blocked gate reads its retire ask). */
  domain: string | null;
  /** When the bounced send happened (the tenant gate waits out its UTC day). */
  sentAt: string;
}

/** D147/D148 — one bounce incident whose sender-fault leads get re-queued. */
export interface BounceResurrectionJob {
  campaignId: number;
  campaignName: string;
  /** When the incident opened (burst classified, or a legacy restart seen). */
  openedAt: string;
  /** Bounced sends inside [windowStart, windowEnd] belong to the incident. */
  windowStart: string;
  windowEnd: string;
  /** Last burst fold-in — receipts and re-classification cool down on this. */
  lastBurstAt: string;
  verdictSummary: string;
  /** Paging cursor into the campaign's bounced rows. */
  offset: number;
  /** Every row paged and classified; only deferred flushes remain. */
  scanDone: boolean;
  /** Sender-fault leads parked until their class's remediation gate opens. */
  deferred: DeferredResurrectionLead[];
  /** Stamped once the campaign's copy is seen edited after openedAt. */
  copyEditedAt?: string | null;
  requeued: number;
  /** How much of `requeued` the Slack receipt has already announced. */
  receipted: number;
  /** Bounces whose own NDR said bad address / unreadable — stay dead. */
  skippedDead: number;
  /** Out-of-window, already-resurrected, or unresolvable rows. */
  skippedOther: number;
  /** Deferred leads dropped because their gate never opened before expiry. */
  dropped: number;
  done: boolean;
}

/** D143 — one membership the warmup gate pulled, counted across re-adds. */
export interface WarmupGatePullRecord {
  email: string;
  campaignId: number;
  campaignName: string;
  /** Pulls inside the rolling 24h window starting at firstAt. */
  count: number;
  firstAt: string;
  lastAt: string;
}

/** D143 — a membership pulled this often in 24h is being re-added from outside. */
export const WARMUP_BOOMERANG_MIN_COUNT = 3;
export const WARMUP_BOOMERANG_WINDOW_MS = 24 * 60 * 60 * 1000;
/** D143 — how long one warmup re-enable write is trusted before rewriting. */
export const WARMUP_ENSURE_TTL_MS = 24 * 60 * 60 * 1000;

export interface RestingInboxRecord {
  accountId: number;
  email: string;
  clientId: string;
  cohort: "A" | "B" | "send";
  kind?: "client" | "generic";
  restingSince: string;
  removedFromCampaigns: number[];
  lastSameEspInbox: number | null;
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
  lastStaffingShort: [],
  testedCampaigns: {},
  alertedKeys: {},
  remediatedKeys: {},
  heldInboxes: {},
  restingInboxes: {},
  genericSendStartedAt: {},
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
  oldClientTeardownAt: null,
  isolation: structuredClone(EMPTY_ISOLATION_STATE),
  campaignChecks: {},
  genericBackfillApprovals: {},
  domainAdvisories: [],
  markerClients: {},
  bounceResurrectionJobs: {},
  resurrectedLeads: {},
  warmupGatePulls: {},
  warmupEnsuredAt: {},
  attachBlocks: {},
  bounceVerdicts: {},
  bounceSnapshots: {},
  bouncePausedCampaigns: {},
  stageHealth: {},
  stageAlertedAt: {},
  canonMissAlerted: {},
  canaryFleetDown: null,
};

export class StateStore {
  private state: AppState = structuredClone(EMPTY_STATE);
  private loaded = false;
  /** D167 — one disk write at a time so overlapping saves cannot clobber. */
  private saveTail: Promise<void> = Promise.resolve();
  private saveSeq = 0;
  /**
   * Test-only: sit between stringify and rename so a concurrent mutation
   * can prove the mutex does not persist a stale snapshot.
   */
  onSaveSnapshot?: () => Promise<void>;

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AppState;
      // D129 — keep a boot-time copy of the last good state so a bad write
      // or a drain gone wrong can be rolled back from the same volume.
      try {
        await writeFile(`${this.filePath}.boot-backup.json`, raw, "utf8");
      } catch (backupError) {
        console.warn("[state] boot backup failed", backupError);
      }
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        testedCampaigns: parsed.testedCampaigns ?? {},
        alertedKeys: parsed.alertedKeys ?? {},
        remediatedKeys: parsed.remediatedKeys ?? {},
        heldInboxes: parsed.heldInboxes ?? {},
        restingInboxes: parsed.restingInboxes ?? {},
        genericSendStartedAt: parsed.genericSendStartedAt ?? {},
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
        lastStaffingShort: Array.isArray(parsed.lastStaffingShort)
          ? parsed.lastStaffingShort
          : [],
        oldClientTeardownAt: parsed.oldClientTeardownAt ?? null,
        isolation: normalizeIsolationState(parsed.isolation),
        campaignChecks: parsed.campaignChecks ?? {},
        genericBackfillApprovals: parsed.genericBackfillApprovals ?? {},
        domainAdvisories: parsed.domainAdvisories ?? [],
        markerClients: parsed.markerClients ?? {},
        attachBlocks: parsed.attachBlocks ?? {},
        bounceVerdicts: parsed.bounceVerdicts ?? {},
        bounceSnapshots: parsed.bounceSnapshots ?? {},
        bouncePausedCampaigns: parsed.bouncePausedCampaigns ?? {},
        stageHealth: parsed.stageHealth ?? {},
        stageAlertedAt: parsed.stageAlertedAt ?? {},
        canonMissAlerted: parsed.canonMissAlerted ?? {},
        canaryFleetDown: parsed.canaryFleetDown ?? null,
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

  clearAllHeldInboxes(): number {
    const n = Object.keys(this.state.heldInboxes).length;
    this.state.heldInboxes = {};
    return n;
  }

  getOldClientTeardownAt(): string | null {
    return this.state.oldClientTeardownAt;
  }

  setOldClientTeardownAt(iso: string): void {
    this.state.oldClientTeardownAt = iso;
  }

  clearMailboxControls(): number {
    const n = Object.keys(this.state.isolation.mailboxResults).length;
    this.state.isolation.mailboxResults = {};
    return n;
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

  getGenericSendStartedAt(email: string): string | undefined {
    return this.state.genericSendStartedAt[email.toLowerCase()];
  }

  markGenericSendStartedAt(email: string, startedAt: string): void {
    const key = email.toLowerCase();
    if (!this.state.genericSendStartedAt[key]) {
      this.state.genericSendStartedAt[key] = startedAt;
    }
  }

  clearGenericSendStartedAt(email: string): void {
    delete this.state.genericSendStartedAt[email.toLowerCase()];
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

  /** D86 — drop a stale planned row (never one mapped to a Smartlead account). */
  removePoolMailbox(email: string): void {
    delete this.state.poolMailboxes[email.toLowerCase()];
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
      if (row.copyCanary) continue;
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
        !m.copyCanary &&
        !this.isCopyCanary(m.email) &&
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
   * (D43 send-clock sit) are not supply either.
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
          !m.copyCanary &&
          !this.isCopyCanary(m.email) &&
          !this.getRestingInbox(m.email) &&
          canTake(m.email),
      );
      if (match) return match;
    }
    return undefined;
  }

  /** D130 — drain every leftover swap reservation; nothing writes them now. */
  clearAllSwaps(): number {
    const n = Object.keys(this.state.activeSwaps).length;
    this.state.activeSwaps = {};
    return n;
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


  /**
   * Drop the original↔generic reservation only. The covering generic stays
   * assigned if it is still on campaigns (D44). Use clearSwap when the
   * generic is actually free again.
   */
  releaseSwapReservation(originalEmail: string): boolean {
    const key = originalEmail.toLowerCase();
    if (!this.state.activeSwaps[key]) return false;
    delete this.state.activeSwaps[key];
    const held = this.state.heldInboxes[key];
    if (held) held.swappedWithPoolEmail = undefined;
    return true;
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

  setLastStaffingShort(rows: StaffingShortRecord[]): void {
    this.state.lastStaffingShort = rows.map((row) => ({ ...row }));
  }

  listLastStaffingShort(): StaffingShortRecord[] {
    return this.state.lastStaffingShort.map((row) => ({ ...row }));
  }

  setLastMailboxSettingsAt(iso: string): void {
    this.state.lastMailboxSettingsAt = iso;
  }

  getCampaignCheck(campaignId: number): CampaignCheckRecord | undefined {
    return this.state.campaignChecks[String(campaignId)];
  }

  upsertCampaignCheck(record: CampaignCheckRecord): void {
    this.state.campaignChecks[String(record.campaignId)] = record;
  }

  listCampaignChecks(): CampaignCheckRecord[] {
    return Object.values(this.state.campaignChecks);
  }

  removeCampaignCheck(campaignId: number): void {
    delete this.state.campaignChecks[String(campaignId)];
  }

  getBounceSnapshot(
    campaignId: number,
  ): {
    bounced: number;
    sent: number;
    at: string;
    senderBlockHint?: string;
  } | undefined {
    return this.state.bounceSnapshots[String(campaignId)];
  }

  setBounceSnapshot(
    campaignId: number,
    snapshot: {
      bounced: number;
      sent: number;
      at: string;
      senderBlockHint?: string;
    },
  ): void {
    this.state.bounceSnapshots[String(campaignId)] = snapshot;
  }

  /**
   * D128 — the D90 loop paused this campaign; only a human STARTs it.
   * D148: the loop never pauses anymore, so nothing in src/ writes new
   * stamps — kept for the pre-D148 stamp drain and tests.
   */
  markBouncePaused(campaignId: number, atIso: string): void {
    this.state.bouncePausedCampaigns[String(campaignId)] = atIso;
  }

  getBouncePausedAt(campaignId: number): string | undefined {
    return this.state.bouncePausedCampaigns[String(campaignId)];
  }

  /** D147/D148 — resurrection bookkeeping for one campaign's incident. */
  upsertBounceResurrectionJob(job: BounceResurrectionJob): void {
    this.state.bounceResurrectionJobs[String(job.campaignId)] = { ...job };
  }

  getBounceResurrectionJob(
    campaignId: number,
  ): BounceResurrectionJob | undefined {
    const job = this.state.bounceResurrectionJobs[String(campaignId)];
    return job ? { ...job } : undefined;
  }

  listBounceResurrectionJobs(): BounceResurrectionJob[] {
    return Object.values(this.state.bounceResurrectionJobs).map((job) => ({
      ...job,
    }));
  }

  /** D147 — a lead is re-queued at most once per campaign (ledger prunes at 45d). */
  wasLeadResurrected(campaignId: number, email: string): boolean {
    return `${campaignId}:${email.toLowerCase()}` in this.state.resurrectedLeads;
  }

  markLeadResurrected(
    campaignId: number,
    email: string,
    now = Date.now(),
  ): void {
    for (const [key, iso] of Object.entries(this.state.resurrectedLeads)) {
      const at = Date.parse(iso);
      if (!Number.isFinite(at) || now - at > 45 * 24 * 60 * 60 * 1000) {
        delete this.state.resurrectedLeads[key];
      }
    }
    this.state.resurrectedLeads[`${campaignId}:${email.toLowerCase()}`] =
      new Date(now).toISOString();
  }

  clearBouncePaused(campaignId: number): void {
    delete this.state.bouncePausedCampaigns[String(campaignId)];
  }

  isBouncePaused(campaignId: number): boolean {
    return String(campaignId) in this.state.bouncePausedCampaigns;
  }

  /** D84 — watchdog bookkeeping for one named stage. */
  recordStageOk(name: string, durationMs: number, skipReason?: string): void {
    const existing = this.state.stageHealth[name];
    this.state.stageHealth[name] = {
      lastOkAt: new Date().toISOString(),
      lastErrorAt: existing?.lastErrorAt ?? null,
      lastError: existing?.lastError ?? null,
      lastDurationMs: durationMs,
      consecutiveFailures: 0,
      lastSkipReason: skipReason ?? null,
    };
  }

  recordStageError(name: string, error: string): void {
    const existing = this.state.stageHealth[name];
    this.state.stageHealth[name] = {
      lastOkAt: existing?.lastOkAt ?? null,
      lastErrorAt: new Date().toISOString(),
      lastError: error.slice(0, 500),
      lastDurationMs: existing?.lastDurationMs ?? null,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      lastSkipReason: existing?.lastSkipReason ?? null,
    };
  }

  listStageHealth(): Record<string, StageHealthRecord> {
    return this.state.stageHealth;
  }

  /** D131 — a stage deleted from the code must not alarm from its record. */
  dropStageHealth(name: string): void {
    delete this.state.stageHealth[name];
    delete this.state.stageAlertedAt[name];
  }

  /** D149 — one Slack page per overdue episode; the stamp IS the episode. */
  listStageAlerts(): Record<string, string> {
    return this.state.stageAlertedAt;
  }

  setStageAlert(name: string, at: string): void {
    this.state.stageAlertedAt[name] = at;
  }

  clearStageAlert(name: string): void {
    delete this.state.stageAlertedAt[name];
  }

  /** D163 — one Slack page per campaign per CANON-miss incident. */
  listCanonMissAlerts(): Record<string, string> {
    return this.state.canonMissAlerted;
  }

  getCanonMissAlert(campaignId: number): string | undefined {
    return this.getCanonMissStamp(String(campaignId));
  }

  setCanonMissAlert(campaignId: number, incident: string): void {
    this.setCanonMissStamp(String(campaignId), incident);
  }

  clearCanonMissAlert(campaignId: number): void {
    this.clearCanonMissStamp(String(campaignId));
  }

  getCanonMissStamp(key: string): string | undefined {
    return this.state.canonMissAlerted[key];
  }

  setCanonMissStamp(key: string, incident: string): void {
    this.state.canonMissAlerted[key] = incident;
  }

  clearCanonMissStamp(key: string): void {
    delete this.state.canonMissAlerted[key];
  }

  /** D85 — one fleet-level fact instead of a finding per campaign. */
  getCanaryFleetDown(): CanaryFleetDownRecord | null {
    return this.state.canaryFleetDown;
  }

  setCanaryFleetDown(record: CanaryFleetDownRecord): void {
    this.state.canaryFleetDown = record;
  }

  clearCanaryFleetDown(): void {
    this.state.canaryFleetDown = null;
  }

  /** D140 — remember what the bounce reasons said, per campaign. */
  setBounceVerdict(record: BounceVerdictRecord): void {
    this.state.bounceVerdicts[String(record.campaignId)] = record;
  }

  getBounceVerdict(campaignId: number): BounceVerdictRecord | undefined {
    return this.state.bounceVerdicts[String(campaignId)];
  }

  listBounceVerdicts(): BounceVerdictRecord[] {
    return Object.values(this.state.bounceVerdicts);
  }

  /** D136 — the monitor's domain→client audit replaces the full list each pass. */
  setDomainAdvisories(advisories: DomainClientAdvisory[]): void {
    this.state.domainAdvisories = advisories;
  }

  listDomainAdvisories(): DomainClientAdvisory[] {
    return this.state.domainAdvisories;
  }

  /** D160 — leftover Generic/POC client ids, recognised only so we can detach. */
  setMarkerClientIds(ids: { genericId?: number; pocId?: number }): void {
    this.state.markerClients = { ...this.state.markerClients, ...ids };
  }

  getMarkerClientIds(): { genericId?: number; pocId?: number } {
    return this.state.markerClients ?? {};
  }

  isMarkerClientId(id: number | null | undefined): boolean {
    if (typeof id !== "number" || !Number.isFinite(id)) return false;
    const { genericId, pocId } = this.state.markerClients ?? {};
    return id === genericId || id === pocId;
  }

  /**
   * D143 — count the gate pulling the same membership again. A membership
   * the gate keeps removing can only reappear because something outside
   * this app adds it back; the count is the detector. Entries expire two
   * windows after their last pull.
   */
  recordWarmupGatePull(
    row: {
      accountId: number;
      campaignId: number;
      email: string;
      campaignName: string;
    },
    now = Date.now(),
  ): number {
    for (const [key, rec] of Object.entries(this.state.warmupGatePulls)) {
      const last = Date.parse(rec.lastAt);
      if (!Number.isFinite(last) || now - last > 2 * WARMUP_BOOMERANG_WINDOW_MS) {
        delete this.state.warmupGatePulls[key];
      }
    }
    const key = `${row.accountId}:${row.campaignId}`;
    const nowIso = new Date(now).toISOString();
    const prior = this.state.warmupGatePulls[key];
    const windowOpen =
      prior != null &&
      Number.isFinite(Date.parse(prior.firstAt)) &&
      now - Date.parse(prior.firstAt) <= WARMUP_BOOMERANG_WINDOW_MS;
    const next: WarmupGatePullRecord = windowOpen
      ? {
          ...prior,
          email: row.email,
          campaignName: row.campaignName,
          count: prior.count + 1,
          lastAt: nowIso,
        }
      : {
          email: row.email,
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          count: 1,
          firstAt: nowIso,
          lastAt: nowIso,
        };
    this.state.warmupGatePulls[key] = next;
    return next.count;
  }

  /** D143 — memberships pulled ≥ minCount times inside the live 24h window. */
  listWarmupGateBoomerangs(
    minCount = WARMUP_BOOMERANG_MIN_COUNT,
    now = Date.now(),
  ): WarmupGatePullRecord[] {
    return Object.values(this.state.warmupGatePulls)
      .filter((rec) => {
        const last = Date.parse(rec.lastAt);
        return (
          rec.count >= minCount &&
          Number.isFinite(last) &&
          now - last <= WARMUP_BOOMERANG_WINDOW_MS
        );
      })
      .map((rec) => ({ ...rec }))
      .sort((a, b) => b.count - a.count);
  }

  /** D143 — warmup re-enable already written for this account recently. */
  warmupEnsuredRecently(accountId: number, now = Date.now()): boolean {
    const at = Date.parse(this.state.warmupEnsuredAt[String(accountId)] ?? "");
    return Number.isFinite(at) && now - at <= WARMUP_ENSURE_TTL_MS;
  }

  markWarmupEnsured(accountId: number, now = Date.now()): void {
    for (const [key, iso] of Object.entries(this.state.warmupEnsuredAt)) {
      const at = Date.parse(iso);
      if (!Number.isFinite(at) || now - at > 2 * WARMUP_ENSURE_TTL_MS) {
        delete this.state.warmupEnsuredAt[key];
      }
    }
    this.state.warmupEnsuredAt[String(accountId)] = new Date(now).toISOString();
  }

  approveGenericBackfill(record: GenericBackfillApproval): void {
    this.state.genericBackfillApprovals[String(record.campaignId)] = record;
  }

  getGenericBackfillApproval(
    campaignId: number,
  ): GenericBackfillApproval | undefined {
    return this.state.genericBackfillApprovals[String(campaignId)];
  }

  listGenericBackfillApprovals(): Record<string, GenericBackfillApproval> {
    return this.state.genericBackfillApprovals;
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

  getIsolation(): IsolationState {
    return this.state.isolation;
  }

  patchIsolation(patch: Partial<IsolationState>): IsolationState {
    this.state.isolation = {
      ...this.state.isolation,
      ...patch,
    };
    return this.state.isolation;
  }

  upsertPodControl(record: PodControlRecord): void {
    this.state.isolation.podControls[record.id] = record;
  }

  listPodControls(): PodControlRecord[] {
    return Object.values(this.state.isolation.podControls);
  }

  upsertMailboxControl(record: MailboxControlResultRecord): void {
    this.state.isolation.mailboxResults[record.email.toLowerCase()] = record;
  }

  getMailboxControl(email: string): MailboxControlResultRecord | undefined {
    return this.state.isolation.mailboxResults[email.toLowerCase()];
  }

  listMailboxControls(): MailboxControlResultRecord[] {
    return Object.values(this.state.isolation.mailboxResults);
  }

  upsertIsolationRun(record: IsolationRunRecord): void {
    this.state.isolation.runs[record.id] = record;
  }

  getIsolationRun(id: string): IsolationRunRecord | undefined {
    return this.state.isolation.runs[id];
  }

  listIsolationRuns(): IsolationRunRecord[] {
    return Object.values(this.state.isolation.runs);
  }

  latestIsolationRunForCampaign(
    campaignId: number,
  ): IsolationRunRecord | undefined {
    return Object.values(this.state.isolation.runs)
      .filter((run) => run.campaignId === campaignId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  upsertIsolationVariant(record: IsolationVariantRecord): void {
    this.state.isolation.variants[record.id] = record;
  }

  listIsolationVariants(runId?: string): IsolationVariantRecord[] {
    const rows = Object.values(this.state.isolation.variants);
    return runId ? rows.filter((row) => row.runId === runId) : rows;
  }

  upsertSuppressedTerm(term: SuppressedTerm): void {
    const scope = (term.clientScope ?? "*").toLowerCase();
    this.state.isolation.suppressedTerms[`${scope}:${term.term.toLowerCase()}`] =
      term;
  }

  listSuppressedTerms(): SuppressedTerm[] {
    return Object.values(this.state.isolation.suppressedTerms);
  }

  markCopySuspect(record: CopySuspectRecord): void {
    this.state.isolation.copySuspects[String(record.campaignId)] = {
      ...this.state.isolation.copySuspects[String(record.campaignId)],
      ...record,
    };
  }

  listCopySuspects(): CopySuspectRecord[] {
    return Object.values(this.state.isolation.copySuspects);
  }

  recordPlacementScore(record: PlacementScoreRecord): void {
    this.state.isolation.placementScores[String(record.campaignId)] = record;
  }

  listPlacementScores(): PlacementScoreRecord[] {
    return Object.values(this.state.isolation.placementScores);
  }

  setCopyCanaries(
    campaignId: number,
    emails: string[],
    testId?: string,
  ): void {
    const unique = [...new Set(emails.map((email) => email.toLowerCase()))];
    const existing = this.state.isolation.copyCanaries[String(campaignId)];
    this.state.isolation.copyCanaries[String(campaignId)] = {
      campaignId,
      emails: unique,
      testId: testId ?? existing?.testId,
      updatedAt: new Date().toISOString(),
    };
  }

  getCopyCanaries(campaignId: number): string[] {
    return this.state.isolation.copyCanaries[String(campaignId)]?.emails ?? [];
  }

  getCopyCanaryTestId(campaignId: number): string | undefined {
    return this.state.isolation.copyCanaries[String(campaignId)]?.testId;
  }

  /** SmartDelivery ids stored under isolation.copyCanaries — not testedCampaigns. */
  listCopyCanaryTestIds(): string[] {
    const out: string[] = [];
    for (const row of Object.values(this.state.isolation.copyCanaries)) {
      if (row.testId) out.push(String(row.testId));
    }
    return out;
  }

  campaignIdForCopyCanaryTestId(testId: string): number | undefined {
    const wanted = String(testId);
    for (const row of Object.values(this.state.isolation.copyCanaries)) {
      if (row.testId && String(row.testId) === wanted) return row.campaignId;
    }
    return undefined;
  }

  listCopyCanaryEmails(): Set<string> {
    const out = new Set<string>();
    for (const row of Object.values(this.state.isolation.copyCanaries)) {
      for (const email of row.emails) out.add(email.toLowerCase());
    }
    return out;
  }

  isCopyCanary(email: string): boolean {
    const lower = email.toLowerCase();
    if (this.listCopyCanaryEmails().has(lower)) return true;
    return isCopyCanaryFleetEmail(lower, this.getCopyCanaryFleet());
  }

  setCopyCanaryFleet(record: CopyCanaryFleetRecord): void {
    this.state.isolation.copyCanaryFleet = {
      ...record,
      domains: [...new Set(record.domains.map((row) => row.toLowerCase()))],
      emails: [...new Set(record.emails.map((row) => row.toLowerCase()))],
    };
  }

  getCopyCanaryFleet(): CopyCanaryFleetRecord | null {
    return this.state.isolation.copyCanaryFleet;
  }

  upsertDomainHistory(record: DomainControlHistoryRecord): void {
    this.state.isolation.domainHistory[record.domain.toLowerCase()] = record;
  }

  getDomainHistory(domain: string): DomainControlHistoryRecord | undefined {
    return this.state.isolation.domainHistory[domain.toLowerCase()];
  }

  upsertAttachBlock(
    incoming: {
      domain: string;
      emails?: Iterable<string>;
      accountIds?: Iterable<number>;
      reason: AttachBlockRecord["reason"];
      source?: string;
      blockedAt?: string;
    },
  ): AttachBlockRecord {
    const host = incoming.domain.trim().toLowerCase();
    const merged = mergeAttachBlock(this.state.attachBlocks[host], incoming);
    this.state.attachBlocks[merged.domain] = merged;
    return merged;
  }

  getAttachBlock(domain: string): AttachBlockRecord | undefined {
    return this.state.attachBlocks[domain.trim().toLowerCase()];
  }

  listAttachBlocks(): AttachBlockRecord[] {
    return Object.values(this.state.attachBlocks);
  }

  /** D176 — restaff writers refuse burned / AS(42004) / restricted senders. */
  isSenderAttachBlocked(sender: {
    email?: string;
    accountId?: number;
    domain?: string;
  }): boolean {
    return senderIsAttachBlocked(sender, this);
  }

  listDomainHistory(): DomainControlHistoryRecord[] {
    return Object.values(this.state.isolation.domainHistory);
  }

  replaceDomainOwners(owners: Record<string, DomainOwnerRecord>): void {
    this.state.isolation.domainOwners = owners;
  }

  upsertDomainOwner(record: DomainOwnerRecord): void {
    this.state.isolation.domainOwners[record.domain.toLowerCase()] = record;
  }

  getDomainOwner(domain: string): DomainOwnerRecord | undefined {
    return this.state.isolation.domainOwners[domain.trim().toLowerCase()];
  }

  listDomainOwners(): DomainOwnerRecord[] {
    return Object.values(this.state.isolation.domainOwners);
  }

  upsertIsolationAction(record: IsolationActionRecord): void {
    this.state.isolation.actions[record.id] = record;
  }

  getIsolationAction(id: string): IsolationActionRecord | undefined {
    return this.state.isolation.actions[id];
  }

  listIsolationActions(): IsolationActionRecord[] {
    return Object.values(this.state.isolation.actions);
  }

  pendingIsolationActions(): IsolationActionRecord[] {
    return this.listIsolationActions().filter(
      (row) => row.status === "pending" || isRetryableReplacementBuy(row),
    );
  }

  /**
   * D167 — serialize disk writes. Concurrent health + monitor used to
   * stringify overlapping snapshots and rename out of order, so a finished
   * stage's lastOk could vanish even after recordStageOk. Each queued save
   * stringifies AFTER it holds the lock, so it sees every mutation that
   * landed before it started writing.
   */
  async save(): Promise<void> {
    const write = async (): Promise<void> => {
      const dir = path.dirname(this.filePath);
      await mkdir(dir, { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${++this.saveSeq}.tmp`;
      const body = JSON.stringify(this.state, null, 2);
      if (this.onSaveSnapshot) await this.onSaveSnapshot();
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.filePath);
    };
    const run = this.saveTail.then(write, write);
    this.saveTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export { currentUtcMonth, emptyMonthlyUsage };
