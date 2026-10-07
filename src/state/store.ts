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
  isReleasedCanaryEmail,
  mergeReleasedCanaryFleet,
  sanitizeCopyCanaryFleet,
  type CopyCanaryFleetRecord,
  type ReleasedCanaryFleetRecord,
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
import type {
  CampaignStandingPref,
  DeliverabilityDecisionRecord,
} from "../lib/deliverabilitySlack.js";
import {
  bounceHoldWindowActive,
  hasTodayTenantCapSignal,
  nextBounceHoldRestoreAt,
} from "../lib/bounceHold.js";
import type { TenantOutboundBlockRecord } from "../lib/tenantOutboundBlock.js";
import { normalizeTenantOutboundHost } from "../lib/tenantOutboundBlock.js";
import {
  applyAssignGenericSeat,
  applyReleaseGenericSeat,
  emptyGenericSeat,
  genericSeatKey,
  normalizeGenericSeat,
  type AssignGenericSeatInput,
  type AssignGenericSeatResult,
  type GenericSeatRecord,
} from "../lib/genericPool.js";
import {
  terlHoldActive,
  terlHeldUntil,
  terlSubstitutionKey,
  type TenantTerlHoldRecord,
  type TerlPausedDay,
  type TerlPausedInbox,
  type TerlSubstitution,
} from "../lib/tenantTerlHold.js";
import { normalizeTerlHost } from "../lib/tenantTerlHold.js";
import {
  evidenceHoldReasonCleared,
  evidenceHoldStillActive,
  type EvidenceHoldRecord,
} from "../lib/evidenceHold.js";
import {
  parseInboxkitLicenseHandoff,
  parseInboxkitSeatEnds,
  seatEndBlocksStaffing,
  seatEndIsLapsed,
  type InboxkitLicenseHandoff,
  type InboxkitSeatEnd,
} from "../lib/inboxkitLicense.js";

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

/** Last successful /ops Placement table, used when SmartDelivery throttles. */
export interface PlacementResultsSnapshot {
  generatedAt: string;
  rows: Array<{
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
  }>;
  /** False when a catalog walk was truncated or smaller than known live tests. */
  complete?: boolean;
  /** Next catalog page. Kept so a 429 does not restart the walk at pod-control tests. */
  listOffset?: number;
  /** Test id the row refresh stopped on. The next pass starts after it so lower rows get a turn. */
  fillCursor?: string;
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
  /** Last successful /ops Placement table, used when SmartDelivery throttles. */
  placementResults: PlacementResultsSnapshot | null;
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
  /** D220 — Chicago YMD of the last Cayden spend digest post. */
  spendDigestPostedYmd: string | null;
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
  /**
   * D194 — Josh/Cayden standing START/PAUSE prefs from #deliverability
   * one-taps. Goliath hold / Insight SEG pause are refused at the handler.
   */
  campaignStandingPrefs: Record<string, CampaignStandingPref>;
  /** D194 — recorded Deliverability Slack button decisions. */
  deliverabilityDecisions: Record<string, DeliverabilityDecisionRecord>;
  /** D205 — last seen PowerGRYD dedicated seat count (alert-only watch). */
  powerGrydSeatCount: number | null;
  /** D205 — last dedicated count we already Slacked a drop for. */
  powerGrydAlertedCount: number | null;
  /**
   * D207 — last Chicago ymd we posted a min-40 / PowerGRYD inventory
   * shortfall `ops_alert` (key = `campaign:<id>` or `powergryd-inventory`).
   */
  min40ShortfallAlerted: Record<string, string>;
  /**
   * D212 / D218 — Smartlead account ids on the D148 bounce-hold list
   * (tenant-cap Outlook zeroed). Daily-limit writers skip raising these.
   * D218: ids persist; they are not cleared at 00:15 UTC.
   */
  bounceHoldAccountIds: number[];
  /** D212 — last TERRL window stamp (informational). D218 does not expire ids. */
  bounceHoldRestoreAfter: string | null;
  /**
   * D213 — permanent Microsoft tenant outbound-block holds (5.1.8 /
   * AS(42004)). No restoreAfter. A human clears the record.
   */
  tenantOutboundBlocks: Record<string, TenantOutboundBlockRecord>;
  /**
   * D221 — fleet-wide generic pool. One row per generic seat
   * (email, sl account, provider, warm-ready, assignment, reason).
   */
  genericSeats: Record<string, GenericSeatRecord>;
  /** D221 — latest generic-pool canon findings (`generic_idle` / `generic_multi_client`). */
  genericPoolFindings: string[];
  /**
   * D236 — overlay so `/run?mode=end-poc` can release a name-list POC
   * without waiting for a Railway env change. Ids stay until cleared.
   */
  endedPocClientIds: number[];
  /**
   * D219 — Microsoft 550 5.7.233 tenant holds. 24h at 0, then the
   * type cap resumes. Other jobs must not write the type default
   * during the window.
   */
  tenantTerlHolds: Record<string, TenantTerlHoldRecord>;
  /** D219 — Chicago-day log of inboxes zeroed for the EOD digest. */
  terlPausedDays: Record<string, TerlPausedDay>;
  /** D219 — temp same-client generic substitutions. Key campaignId:stoppedId. */
  terlSubstitutions: Record<string, TerlSubstitution>;
  /**
   * D224 — every accepted hold stores its own reason and evidence.
   * Keyed by email. Expires when the reason clears, or at 30 days.
   */
  evidenceHolds: Record<string, EvidenceHoldRecord>;
  /**
   * D226 — latest Monday InboxKit license sweep handoff for Onboarding
   * and Deliverability (per-client lapsed + upcoming cancellations).
   */
  inboxkitLicenseHandoff: InboxkitLicenseHandoff | null;
  /**
   * D245 — InboxKit seats that are lapsed or scheduled to cancel, with
   * their cancel date. Written by every weekday license sweep. Staffing
   * never attaches a seat that is lapsed or ends within 7 days.
   */
  inboxkitSeatEnds: Record<string, InboxkitSeatEnd>;
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

function parseTenantOutboundBlocks(
  raw: unknown,
): Record<string, TenantOutboundBlockRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TenantOutboundBlockRecord> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const tenant = normalizeTenantOutboundHost(
      typeof row.tenant === "string" ? row.tenant : key,
    );
    if (!tenant) continue;
    const domains = Array.isArray(row.domains)
      ? row.domains
          .filter((d): d is string => typeof d === "string")
          .map(normalizeTenantOutboundHost)
          .filter(Boolean)
      : [];
    const accountIds = Array.isArray(row.accountIds)
      ? row.accountIds.filter(
          (id): id is number => Number.isFinite(id) && Number(id) > 0,
        )
      : [];
    out[tenant] = {
      tenant,
      domains: [...new Set(domains)],
      accountIds: [...new Set(accountIds)],
      alertedAt: typeof row.alertedAt === "string" ? row.alertedAt : null,
      seededAt: typeof row.seededAt === "string" ? row.seededAt : "",
    };
  }
  return out;
}

function parseGenericSeats(raw: unknown): Record<string, GenericSeatRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, GenericSeatRecord> = {};
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const seat = normalizeGenericSeat(value);
    if (!seat) continue;
    out[seat.email] = seat;
  }
  return out;
}

function parseTenantTerlHolds(
  raw: unknown,
): Record<string, TenantTerlHoldRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TenantTerlHoldRecord> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const tenant = normalizeTerlHost(
      typeof row.tenant === "string" ? row.tenant : key,
    );
    if (!tenant) continue;
    const domains = Array.isArray(row.domains)
      ? row.domains
          .filter((d): d is string => typeof d === "string")
          .map(normalizeTerlHost)
          .filter(Boolean)
      : [];
    const accountIds = Array.isArray(row.accountIds)
      ? row.accountIds.filter(
          (id): id is number => Number.isFinite(id) && Number(id) > 0,
        )
      : [];
    if (typeof row.heldUntil !== "string" || !row.heldUntil) continue;
    out[tenant] = {
      tenant,
      domains: [...new Set(domains)],
      accountIds: [...new Set(accountIds)],
      heldUntil: row.heldUntil,
      firstHeldAt: typeof row.firstHeldAt === "string" ? row.firstHeldAt : row.heldUntil,
    };
  }
  return out;
}

function parseEvidenceHolds(raw: unknown): Record<string, EvidenceHoldRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, EvidenceHoldRecord> = {};
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const email = String(row.email ?? "").trim().toLowerCase();
    const domain = String(row.domain ?? "").trim().toLowerCase();
    const reason = String(row.reason ?? "");
    if (!email || !domain || !reason) continue;
    if (typeof row.heldAt !== "string" || typeof row.expiresAt !== "string") continue;
    const accountId = Number(row.accountId);
    out[email] = {
      email,
      accountId:
        Number.isFinite(accountId) && accountId > 0 ? accountId : undefined,
      domain,
      reason: reason as EvidenceHoldRecord["reason"],
      evidence:
        row.evidence && typeof row.evidence === "object"
          ? { ...(row.evidence as EvidenceHoldRecord["evidence"]) }
          : {},
      heldAt: row.heldAt,
      expiresAt: row.expiresAt,
      source: String(row.source ?? "hold-request"),
      tagName: String(row.tagName ?? ""),
    };
  }
  return out;
}

function parseTerlPausedDays(raw: unknown): Record<string, TerlPausedDay> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TerlPausedDay> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const ymd = typeof row.ymd === "string" ? row.ymd : key;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    const inboxes = Array.isArray(row.inboxes)
      ? row.inboxes.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const rec = item as Record<string, unknown>;
          const accountId = Number(rec.accountId);
          const email = String(rec.email ?? "").trim().toLowerCase();
          if (!Number.isFinite(accountId) || accountId <= 0 || !email) return [];
          return [
            {
              accountId,
              email,
              clientId:
                typeof rec.clientId === "number" && Number.isFinite(rec.clientId)
                  ? rec.clientId
                  : null,
              clientName: String(rec.clientName ?? ""),
              tenant: normalizeTerlHost(String(rec.tenant ?? "")),
              pausedAt: typeof rec.pausedAt === "string" ? rec.pausedAt : "",
            } satisfies TerlPausedInbox,
          ];
        })
      : [];
    out[ymd] = {
      ymd,
      postedAt: typeof row.postedAt === "string" ? row.postedAt : null,
      inboxes,
    };
  }
  return out;
}

function parseTerlSubstitutions(raw: unknown): Record<string, TerlSubstitution> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TerlSubstitution> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const stoppedAccountId = Number(row.stoppedAccountId);
    const campaignId = Number(row.campaignId);
    const clientId = Number(row.clientId);
    if (
      !Number.isFinite(stoppedAccountId) ||
      stoppedAccountId <= 0 ||
      !Number.isFinite(campaignId) ||
      campaignId <= 0 ||
      !Number.isFinite(clientId) ||
      clientId <= 0
    ) {
      continue;
    }
    const storedKey =
      typeof key === "string" && key.includes(":")
        ? key
        : terlSubstitutionKey(campaignId, stoppedAccountId);
    out[storedKey] = {
      stoppedAccountId,
      stoppedEmail: String(row.stoppedEmail ?? "").toLowerCase(),
      substituteAccountId:
        typeof row.substituteAccountId === "number" &&
        Number.isFinite(row.substituteAccountId)
          ? row.substituteAccountId
          : null,
      substituteEmail:
        typeof row.substituteEmail === "string"
          ? row.substituteEmail.toLowerCase()
          : null,
      campaignId,
      campaignName: String(row.campaignName ?? ""),
      clientId,
      clientName: String(row.clientName ?? ""),
      tenant: normalizeTerlHost(String(row.tenant ?? "")),
      stoppedAt: typeof row.stoppedAt === "string" ? row.stoppedAt : "",
      restoreAfter: typeof row.restoreAfter === "string" ? row.restoreAfter : "",
      restoredAt: typeof row.restoredAt === "string" ? row.restoredAt : null,
      noSubstitute: row.noSubstitute === true,
    };
  }
  return out;
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
  placementResults: null,
  opsCursorAgents: {},
  bugRemediations: {},
  pendingResumes: {},
  oldClientTeardownAt: null,
  spendDigestPostedYmd: null,
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
  campaignStandingPrefs: {},
  deliverabilityDecisions: {},
  powerGrydSeatCount: null,
  powerGrydAlertedCount: null,
  min40ShortfallAlerted: {},
  bounceHoldAccountIds: [],
  bounceHoldRestoreAfter: null,
  tenantOutboundBlocks: {},
  genericSeats: {},
  genericPoolFindings: [],
  endedPocClientIds: [],
  tenantTerlHolds: {},
  terlPausedDays: {},
  terlSubstitutions: {},
  evidenceHolds: {},
  inboxkitLicenseHandoff: null,
  inboxkitSeatEnds: {},
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
        placementResults: parsed.placementResults ?? null,
        opsCursorAgents: parsed.opsCursorAgents ?? {},
        bugRemediations: parsed.bugRemediations ?? {},
        pendingResumes: parsed.pendingResumes ?? {},
        lastHealthAt: parsed.lastHealthAt ?? null,
        lastMailboxSettingsAt: parsed.lastMailboxSettingsAt ?? null,
        lastStaffingShort: Array.isArray(parsed.lastStaffingShort)
          ? parsed.lastStaffingShort
          : [],
        oldClientTeardownAt: parsed.oldClientTeardownAt ?? null,
        spendDigestPostedYmd:
          typeof parsed.spendDigestPostedYmd === "string"
            ? parsed.spendDigestPostedYmd
            : null,
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
        campaignStandingPrefs: parsed.campaignStandingPrefs ?? {},
        deliverabilityDecisions: parsed.deliverabilityDecisions ?? {},
        powerGrydSeatCount:
          typeof parsed.powerGrydSeatCount === "number"
            ? parsed.powerGrydSeatCount
            : null,
        powerGrydAlertedCount:
          typeof parsed.powerGrydAlertedCount === "number"
            ? parsed.powerGrydAlertedCount
            : null,
        min40ShortfallAlerted: parsed.min40ShortfallAlerted ?? {},
        bounceHoldAccountIds: Array.isArray(parsed.bounceHoldAccountIds)
          ? parsed.bounceHoldAccountIds.filter(
              (id): id is number => Number.isFinite(id) && id > 0,
            )
          : [],
        bounceHoldRestoreAfter:
          typeof parsed.bounceHoldRestoreAfter === "string"
            ? parsed.bounceHoldRestoreAfter
            : null,
        tenantOutboundBlocks: parseTenantOutboundBlocks(
          parsed.tenantOutboundBlocks,
        ),
        genericSeats: parseGenericSeats(parsed.genericSeats),
        endedPocClientIds: Array.isArray(parsed.endedPocClientIds)
          ? parsed.endedPocClientIds.filter(
              (id): id is number => Number.isFinite(id) && id > 0,
            )
          : [],
        genericPoolFindings: Array.isArray(parsed.genericPoolFindings)
          ? parsed.genericPoolFindings
              .map((line) => String(line))
              .filter((line) => line.trim().length > 0)
          : [],
        tenantTerlHolds: parseTenantTerlHolds(parsed.tenantTerlHolds),
        terlPausedDays: parseTerlPausedDays(parsed.terlPausedDays),
        terlSubstitutions: parseTerlSubstitutions(parsed.terlSubstitutions),
        evidenceHolds: parseEvidenceHolds(parsed.evidenceHolds),
        inboxkitLicenseHandoff: parseInboxkitLicenseHandoff(
          parsed.inboxkitLicenseHandoff,
        ),
        inboxkitSeatEnds: parseInboxkitSeatEnds(parsed.inboxkitSeatEnds),
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

  spendDigestPosted(ymd: string): boolean {
    return this.state.spendDigestPostedYmd === ymd;
  }

  markSpendDigestPosted(ymd: string): void {
    this.state.spendDigestPostedYmd = ymd;
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

  setInboxkitLicenseHandoff(handoff: InboxkitLicenseHandoff): void {
    this.state.inboxkitLicenseHandoff = handoff;
  }

  getInboxkitLicenseHandoff(): InboxkitLicenseHandoff | null {
    return this.state.inboxkitLicenseHandoff;
  }

  /** D245 — replace the InboxKit seat end map (each sweep is a full read). */
  setInboxkitSeatEnds(ends: Record<string, InboxkitSeatEnd>): void {
    this.state.inboxkitSeatEnds = { ...ends };
  }

  getInboxkitSeatEnd(email: string): InboxkitSeatEnd | undefined {
    return this.state.inboxkitSeatEnds?.[email.trim().toLowerCase()];
  }

  /** D245 — lapsed now (cancel date reached, or lapsed status). */
  isInboxKitLapsed(email: string, now: Date = new Date()): boolean {
    return seatEndIsLapsed(this.getInboxkitSeatEnd(email), now);
  }

  /** D245 — do not staff: lapsed, or the InboxKit end date is within 7 days. */
  isInboxKitEndingSoon(email: string, now: Date = new Date(), days = 7): boolean {
    return seatEndBlocksStaffing(this.getInboxkitSeatEnd(email), now, days);
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

  setPlacementResults(snapshot: PlacementResultsSnapshot): void {
    this.state.placementResults = snapshot;
  }

  getPlacementResults(): PlacementResultsSnapshot | null {
    return this.state.placementResults;
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

  /** D221 / D231 — fleet-wide generic seat table. Seed only; assign via assignGenericFromTable. */
  upsertGenericSeat(record: GenericSeatRecord): void {
    const seat = normalizeGenericSeat(record);
    if (!seat) return;
    this.state.genericSeats[seat.email] = seat;
  }

  /**
   * D231 — insert an unassigned table row for a live generic.
   * Does not hand the seat out. Assign still goes through
   * assignGenericFromTable.
   */
  ensureGenericSeat(
    record: Pick<GenericSeatRecord, "email"> & Partial<GenericSeatRecord>,
  ): GenericSeatRecord | null {
    const key = genericSeatKey(record.email);
    const existing = this.state.genericSeats[key];
    if (existing) return existing;
    const seat = emptyGenericSeat(record.email, {
      ...record,
      assignedClientId: null,
      assignedCampaignIds: [],
      assignedPod: null,
      assignedAt: null,
      reason: null,
    });
    this.state.genericSeats[seat.email] = seat;
    return seat;
  }

  getGenericSeat(email: string): GenericSeatRecord | undefined {
    return this.state.genericSeats[genericSeatKey(email)];
  }

  listGenericSeats(): GenericSeatRecord[] {
    return Object.values(this.state.genericSeats);
  }

  replaceGenericSeats(seats: GenericSeatRecord[]): void {
    const next: Record<string, GenericSeatRecord> = {};
    for (const raw of seats) {
      const seat = normalizeGenericSeat(raw);
      if (!seat) continue;
      next[seat.email] = seat;
    }
    this.state.genericSeats = next;
  }

  /** D231 — sole assignment write. Refuses missing rows, other clients, POD rotate. */
  assignGenericFromTable(input: AssignGenericSeatInput): AssignGenericSeatResult {
    const existing = this.state.genericSeats[genericSeatKey(input.email)];
    const result = applyAssignGenericSeat(existing, input);
    if (result.ok) this.state.genericSeats[result.seat.email] = result.seat;
    return result;
  }

  /** D231 — sole release write. Appends released_at history. */
  releaseGenericFromTable(
    email: string,
    opts: { now?: Date; reason?: string | null } = {},
  ): GenericSeatRecord | null {
    const key = genericSeatKey(email);
    const seat = this.state.genericSeats[key];
    if (!seat) return null;
    const next = applyReleaseGenericSeat(seat, opts);
    this.state.genericSeats[key] = next;
    return next;
  }

  clearGenericSeatAssignment(email: string): void {
    this.releaseGenericFromTable(email);
  }

  setGenericPoolFindings(findings: string[]): void {
    this.state.genericPoolFindings = findings
      .map((line) => String(line))
      .filter((line) => line.trim().length > 0);
  }

  listGenericPoolFindings(): string[] {
    return [...this.state.genericPoolFindings];
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

  /** D205 — PowerGRYD dedicated-seat watch (alert-only). */
  getPowerGrydSeatCount(): number | null {
    return this.state.powerGrydSeatCount;
  }

  setPowerGrydSeatCount(count: number): void {
    this.state.powerGrydSeatCount = count;
  }

  getPowerGrydAlertedCount(): number | null {
    return this.state.powerGrydAlertedCount;
  }

  setPowerGrydAlertedCount(count: number): void {
    this.state.powerGrydAlertedCount = count;
  }

  /** D236 — overlay so a name-list POC can be marked done without an env change. */
  listEndedPocClientIds(): number[] {
    return [...this.state.endedPocClientIds];
  }

  isPocEnded(clientId: number | null | undefined): boolean {
    return (
      typeof clientId === "number" &&
      this.state.endedPocClientIds.includes(clientId)
    );
  }

  markPocEnded(clientId: number): void {
    if (!Number.isFinite(clientId) || clientId <= 0) return;
    if (!this.state.endedPocClientIds.includes(clientId)) {
      this.state.endedPocClientIds.push(clientId);
    }
  }

  clearPocEnded(clientId: number): void {
    this.state.endedPocClientIds = this.state.endedPocClientIds.filter(
      (id) => id !== clientId,
    );
  }

  /** D207 — one min-40 / PG inventory Slack per key per Chicago day. */
  getMin40ShortfallAlerted(key: string): string | undefined {
    return this.state.min40ShortfallAlerted[key];
  }

  setMin40ShortfallAlerted(key: string, ymd: string): void {
    this.state.min40ShortfallAlerted[key] = ymd;
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

  /** D212 — bounce-hold list is Smartlead account ids. D218: no time expiry. */
  isBounceHoldWindowActive(now = new Date()): boolean {
    return bounceHoldWindowActive(this.state.bounceHoldRestoreAfter, now);
  }

  isBounceHoldAccount(accountId: number, _now = new Date()): boolean {
    const id = Number(accountId);
    if (!Number.isFinite(id) || id <= 0) return false;
    void _now;
    // D218 — listed ids stay held after 00:15 UTC. The window is only
    // used for unlisted Outlook-at-0 re-zeros (accountOnBounceHold).
    return this.state.bounceHoldAccountIds.includes(id);
  }

  listBounceHoldAccountIds(): number[] {
    return [...this.state.bounceHoldAccountIds];
  }

  getBounceHoldRestoreAfter(): string | null {
    return this.state.bounceHoldRestoreAfter;
  }

  private shouldArmBounceHold(now: Date): boolean {
    if (this.isBounceHoldWindowActive(now)) return true;
    if (!this.state.bounceHoldRestoreAfter) return true;
    return hasTodayTenantCapSignal(
      {
        alertedKeys: this.state.alertedKeys,
        bounceVerdicts: this.listBounceVerdicts(),
      },
      now,
    );
  }

  private addBounceHoldId(accountId: number): void {
    const id = Number(accountId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (!this.state.bounceHoldAccountIds.includes(id)) {
      this.state.bounceHoldAccountIds.push(id);
    }
  }

  observeBounceHoldZero(accountId: number, now = new Date()): void {
    if (!this.shouldArmBounceHold(now)) return;
    this.addBounceHoldId(accountId);
    if (!this.isBounceHoldWindowActive(now)) {
      this.state.bounceHoldRestoreAfter = nextBounceHoldRestoreAt(now).toISOString();
    }
  }

  ensureBounceHold(accountIds: Iterable<number>, now = new Date()): void {
    for (const id of accountIds) this.addBounceHoldId(id);
    this.state.bounceHoldRestoreAfter = nextBounceHoldRestoreAt(now).toISOString();
  }

  /**
   * D218 — do not clear TERRL hold ids at 7:15pm CT. The old prune is
   * what let mailbox-settings write 15 again. Kept as a no-op so
   * callers (mailbox-settings) stay compiled.
   */
  pruneBounceHold(_now = new Date()): void {
    void _now;
  }

  clearBounceHoldAccount(accountId: number): boolean {
    const id = Number(accountId);
    if (!Number.isFinite(id) || id <= 0) return false;
    const before = this.state.bounceHoldAccountIds.length;
    this.state.bounceHoldAccountIds = this.state.bounceHoldAccountIds.filter(
      (row) => row !== id,
    );
    return this.state.bounceHoldAccountIds.length !== before;
  }

  /** D213 — permanent tenant outbound-block hold. Never cleared by pruneBounceHold. */
  isTenantOutboundBlockAccount(accountId: number): boolean {
    const id = Number(accountId);
    if (!Number.isFinite(id) || id <= 0) return false;
    return Object.values(this.state.tenantOutboundBlocks).some((row) =>
      row.accountIds.includes(id),
    );
  }

  isTenantOutboundBlockDomain(domain: string): boolean {
    const host = normalizeTenantOutboundHost(domain);
    if (!host) return false;
    return Object.values(this.state.tenantOutboundBlocks).some(
      (row) => row.tenant === host || row.domains.includes(host),
    );
  }

  listTenantOutboundBlocks(): TenantOutboundBlockRecord[] {
    return Object.values(this.state.tenantOutboundBlocks).map((row) => ({
      ...row,
      domains: [...row.domains],
      accountIds: [...row.accountIds],
    }));
  }

  listTenantOutboundBlockAccountIds(): number[] {
    return [
      ...new Set(
        Object.values(this.state.tenantOutboundBlocks).flatMap(
          (row) => row.accountIds,
        ),
      ),
    ];
  }

  ensureTenantOutboundBlock(input: {
    tenant?: string;
    domains?: Iterable<string>;
    accountIds?: Iterable<number>;
    now?: Date;
  }): TenantOutboundBlockRecord | undefined {
    const domains = [
      ...new Set(
        [...(input.domains ?? [])]
          .map(normalizeTenantOutboundHost)
          .filter(Boolean),
      ),
    ];
    const accountIds = [
      ...new Set(
        [...(input.accountIds ?? [])].filter(
          (id) => Number.isFinite(id) && id > 0,
        ),
      ),
    ];
    const tenantHint = input.tenant
      ? normalizeTenantOutboundHost(input.tenant)
      : "";
    let record =
      (tenantHint ? this.state.tenantOutboundBlocks[tenantHint] : undefined) ??
      Object.values(this.state.tenantOutboundBlocks).find(
        (row) =>
          (tenantHint && row.tenant === tenantHint) ||
          row.domains.some((domain) => domains.includes(domain)),
      );
    const key = tenantHint || record?.tenant || domains[0];
    if (!key) return undefined;
    if (!record) {
      record = {
        tenant: key,
        domains: [],
        accountIds: [],
        alertedAt: null,
        seededAt: (input.now ?? new Date()).toISOString(),
      };
      this.state.tenantOutboundBlocks[key] = record;
    } else if (tenantHint && record.tenant !== tenantHint) {
      delete this.state.tenantOutboundBlocks[record.tenant];
      record.tenant = tenantHint;
      this.state.tenantOutboundBlocks[tenantHint] = record;
    }
    for (const domain of domains) {
      if (!record.domains.includes(domain)) record.domains.push(domain);
    }
    for (const id of accountIds) {
      if (!record.accountIds.includes(id)) record.accountIds.push(id);
    }
    return record;
  }

  markTenantOutboundBlockAlerted(tenant: string, now = new Date()): void {
    const host = normalizeTenantOutboundHost(tenant);
    const record =
      this.state.tenantOutboundBlocks[host] ??
      Object.values(this.state.tenantOutboundBlocks).find(
        (row) => row.tenant === host || row.domains.includes(host),
      );
    if (record) record.alertedAt = now.toISOString();
  }

  clearTenantOutboundBlock(tenantOrDomain: string): boolean {
    const host = normalizeTenantOutboundHost(tenantOrDomain);
    if (!host) return false;
    if (this.state.tenantOutboundBlocks[host]) {
      delete this.state.tenantOutboundBlocks[host];
      return true;
    }
    for (const [key, row] of Object.entries(this.state.tenantOutboundBlocks)) {
      if (row.tenant === host || row.domains.includes(host)) {
        delete this.state.tenantOutboundBlocks[key];
        return true;
      }
    }
    return false;
  }

  /** D219 — 5.7.233 tenant hold. Rolling 24h, then type cap. */
  getTenantTerlHold(tenantOrDomain: string): TenantTerlHoldRecord | undefined {
    const host = normalizeTerlHost(tenantOrDomain);
    if (!host) return undefined;
    return (
      this.state.tenantTerlHolds[host] ??
      Object.values(this.state.tenantTerlHolds).find(
        (row) => row.tenant === host || row.domains.includes(host),
      )
    );
  }

  listTenantTerlHolds(): TenantTerlHoldRecord[] {
    return Object.values(this.state.tenantTerlHolds).map((row) => ({
      ...row,
      domains: [...row.domains],
      accountIds: [...row.accountIds],
    }));
  }

  isTenantTerlHoldAccount(accountId: number, now = new Date()): boolean {
    const id = Number(accountId);
    if (!Number.isFinite(id) || id <= 0) return false;
    return Object.values(this.state.tenantTerlHolds).some(
      (row) => row.accountIds.includes(id) && terlHoldActive(row.heldUntil, now),
    );
  }

  isTenantTerlHoldDomain(domain: string, now = new Date()): boolean {
    const record = this.getTenantTerlHold(domain);
    return Boolean(record && terlHoldActive(record.heldUntil, now));
  }

  ensureTenantTerlHold(input: {
    tenant?: string;
    domains?: Iterable<string>;
    accountIds?: Iterable<number>;
    now?: Date;
  }): TenantTerlHoldRecord | undefined {
    const now = input.now ?? new Date();
    const domains = [
      ...new Set(
        [...(input.domains ?? [])].map(normalizeTerlHost).filter(Boolean),
      ),
    ];
    const accountIds = [
      ...new Set(
        [...(input.accountIds ?? [])].filter(
          (id) => Number.isFinite(id) && id > 0,
        ),
      ),
    ];
    const tenantHint = input.tenant ? normalizeTerlHost(input.tenant) : "";
    let record =
      (tenantHint ? this.state.tenantTerlHolds[tenantHint] : undefined) ??
      Object.values(this.state.tenantTerlHolds).find(
        (row) =>
          (tenantHint && row.tenant === tenantHint) ||
          row.domains.some((domain) => domains.includes(domain)),
      );
    const key = tenantHint || record?.tenant || domains[0];
    if (!key) return undefined;
    const rolling = Boolean(record && terlHoldActive(record.heldUntil, now));
    if (!record) {
      record = {
        tenant: key,
        domains: [],
        accountIds: [],
        heldUntil: terlHeldUntil(now).toISOString(),
        firstHeldAt: now.toISOString(),
      };
      this.state.tenantTerlHolds[key] = record;
    } else {
      if (tenantHint && record.tenant !== tenantHint) {
        delete this.state.tenantTerlHolds[record.tenant];
        record.tenant = tenantHint;
        this.state.tenantTerlHolds[tenantHint] = record;
      }
      record.heldUntil = terlHeldUntil(now).toISOString();
      if (!rolling) record.firstHeldAt = now.toISOString();
    }
    for (const domain of domains) {
      if (!record.domains.includes(domain)) record.domains.push(domain);
    }
    for (const id of accountIds) {
      if (!record.accountIds.includes(id)) record.accountIds.push(id);
    }
    return record;
  }

  /** D224 — persist one gated hold with its reason and evidence. */
  upsertEvidenceHold(record: EvidenceHoldRecord): void {
    this.state.evidenceHolds[record.email.toLowerCase()] = {
      ...record,
      email: record.email.toLowerCase(),
      domain: record.domain.toLowerCase(),
      evidence: { ...record.evidence },
    };
  }

  getEvidenceHold(email: string): EvidenceHoldRecord | undefined {
    return this.state.evidenceHolds[email.trim().toLowerCase()];
  }

  listEvidenceHolds(now = new Date()): EvidenceHoldRecord[] {
    return Object.values(this.state.evidenceHolds).filter((row) =>
      evidenceHoldStillActive(row, now),
    );
  }

  isEvidenceHoldAccount(accountId: number, now = new Date()): boolean {
    const id = Number(accountId);
    if (!Number.isFinite(id) || id <= 0) return false;
    return Object.values(this.state.evidenceHolds).some(
      (row) => row.accountId === id && evidenceHoldStillActive(row, now),
    );
  }

  pruneEvidenceHolds(
    now = new Date(),
    context: { retiredDomains?: Iterable<string>; badSenderDomains?: Iterable<string> } = {},
  ): number {
    let removed = 0;
    for (const [key, row] of Object.entries(this.state.evidenceHolds)) {
      if (
        !evidenceHoldStillActive(row, now) ||
        evidenceHoldReasonCleared(row, context)
      ) {
        delete this.state.evidenceHolds[key];
        removed += 1;
      }
    }
    return removed;
  }

  recordTerlPausedInboxes(input: {
    ymd: string;
    inboxes: Iterable<TerlPausedInbox>;
  }): void {
    const ymd = input.ymd.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;
    const day = this.state.terlPausedDays[ymd] ?? {
      ymd,
      postedAt: null,
      inboxes: [],
    };
    for (const row of input.inboxes) {
      const email = row.email.trim().toLowerCase();
      if (!email || !Number.isFinite(row.accountId) || row.accountId <= 0) continue;
      const existing = day.inboxes.find(
        (item) => item.accountId === row.accountId || item.email === email,
      );
      if (existing) continue;
      day.inboxes.push({
        ...row,
        email,
        tenant: normalizeTerlHost(row.tenant),
      });
    }
    this.state.terlPausedDays[ymd] = day;
  }

  listTerlPausedInboxes(ymd: string): TerlPausedInbox[] {
    return [...(this.state.terlPausedDays[ymd]?.inboxes ?? [])];
  }

  terlEodPosted(ymd: string): boolean {
    return Boolean(this.state.terlPausedDays[ymd]?.postedAt);
  }

  markTerlEodPosted(ymd: string, now = new Date()): void {
    const day = this.state.terlPausedDays[ymd] ?? {
      ymd,
      postedAt: null,
      inboxes: [],
    };
    day.postedAt = now.toISOString();
    this.state.terlPausedDays[ymd] = day;
  }

  upsertTerlSubstitution(row: TerlSubstitution): void {
    const key = terlSubstitutionKey(row.campaignId, row.stoppedAccountId);
    this.state.terlSubstitutions[key] = { ...row };
  }

  listTerlSubstitutions(): TerlSubstitution[] {
    return Object.values(this.state.terlSubstitutions).map((row) => ({ ...row }));
  }

  listActiveTerlSubstitutions(): TerlSubstitution[] {
    return this.listTerlSubstitutions().filter((row) => !row.restoredAt);
  }

  listExpiredTerlSubstitutions(now = new Date()): TerlSubstitution[] {
    return this.listTerlSubstitutions().filter(
      (row) => !row.restoredAt && Date.parse(row.restoreAfter) <= now.getTime(),
    );
  }

  markTerlSubstitutionRestored(key: string, now = new Date()): void {
    const row = this.state.terlSubstitutions[key];
    if (row) row.restoredAt = now.toISOString();
  }

  getTerlSubstitution(
    campaignId: number,
    stoppedAccountId: number,
  ): TerlSubstitution | undefined {
    return this.state.terlSubstitutions[
      terlSubstitutionKey(campaignId, stoppedAccountId)
    ];
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
    const unique = [
      ...new Set(
        emails
          .map((email) => email.toLowerCase())
          .filter((email) => !this.isReleasedCanary(email)),
      ),
    ];
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
      for (const email of row.emails) {
        const key = email.toLowerCase();
        if (!this.isReleasedCanary(key)) out.add(key);
      }
    }
    return out;
  }

  isReleasedCanary(email: string): boolean {
    return isReleasedCanaryEmail(email, this.getReleasedCanaryFleet());
  }

  getReleasedCanaryFleet(): ReleasedCanaryFleetRecord {
    return mergeReleasedCanaryFleet(this.state.isolation.releasedCanaryFleet);
  }

  setReleasedCanaryFleet(record: ReleasedCanaryFleetRecord): void {
    this.state.isolation.releasedCanaryFleet = mergeReleasedCanaryFleet(record);
  }

  mergeReleasedCanaryFleet(
    extra?: Partial<ReleasedCanaryFleetRecord> | null,
  ): ReleasedCanaryFleetRecord {
    const merged = mergeReleasedCanaryFleet(
      this.state.isolation.releasedCanaryFleet,
      extra,
    );
    this.state.isolation.releasedCanaryFleet = merged;
    return merged;
  }

  isCopyCanary(email: string): boolean {
    const lower = email.toLowerCase();
    if (this.isReleasedCanary(lower)) return false;
    if (this.listCopyCanaryEmails().has(lower)) return true;
    return isCopyCanaryFleetEmail(
      lower,
      this.getCopyCanaryFleet(),
      this.getReleasedCanaryFleet(),
    );
  }

  setCopyCanaryFleet(record: CopyCanaryFleetRecord): void {
    const released = this.getReleasedCanaryFleet();
    const sanitized = sanitizeCopyCanaryFleet(
      {
        ...record,
        domains: [...new Set(record.domains.map((row) => row.toLowerCase()))],
        emails: [...new Set(record.emails.map((row) => row.toLowerCase()))],
      },
      released,
    );
    this.state.isolation.copyCanaryFleet = sanitized;
  }

  getCopyCanaryFleet(): CopyCanaryFleetRecord | null {
    const sanitized = sanitizeCopyCanaryFleet(
      this.state.isolation.copyCanaryFleet,
      this.getReleasedCanaryFleet(),
    );
    if (
      sanitized &&
      this.state.isolation.copyCanaryFleet &&
      (sanitized.emails.length !==
        this.state.isolation.copyCanaryFleet.emails.length ||
        sanitized.domains.length !==
          this.state.isolation.copyCanaryFleet.domains.length)
    ) {
      this.state.isolation.copyCanaryFleet = sanitized;
    }
    return sanitized;
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

  setCampaignStandingPref(pref: CampaignStandingPref): void {
    this.state.campaignStandingPrefs[String(pref.campaignId)] = pref;
  }

  getCampaignStandingPref(campaignId: number): CampaignStandingPref | undefined {
    return this.state.campaignStandingPrefs[String(campaignId)];
  }

  listCampaignStandingPrefs(): CampaignStandingPref[] {
    return Object.values(this.state.campaignStandingPrefs);
  }

  recordDeliverabilityDecision(record: DeliverabilityDecisionRecord): void {
    this.state.deliverabilityDecisions[record.id] = record;
  }

  listDeliverabilityDecisions(): DeliverabilityDecisionRecord[] {
    return Object.values(this.state.deliverabilityDecisions);
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
