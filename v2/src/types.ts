export type Role = "api" | "staff" | "isolation" | "all";

export type Pod = "A" | "B";

export type ActionKind =
  | "attach"
  | "detach"
  | "isolate"
  | "test_create"
  | "test_stop"
  | "signature_write"
  | "sequence_write"
  | "inboxkit_delete"
  | "smartlead_delete"
  | "spend"
  | "slack"
  | "pause"
  | "start"
  | "reconnect"
  | "tag"
  | "word_hunt"
  | "mpd_write"
  | "hold"
  | "settings_write"
  | "schedule_write";

export type CanaryKind = "warmed" | "unwarmed";
export type FailureClass = "sender" | "copy" | "none";
export type QaRole = "staff" | "isolation";
export type QaTrigger = "scheduled" | "new_copy" | "new_leads";
export type QaRunStatus = "scheduled" | "running" | "completed" | "missed";

export interface IntendedAction {
  id?: number;
  at?: string;
  kind: ActionKind;
  campaignId?: number;
  accountId?: number;
  email?: string;
  payload: Record<string, unknown>;
  executed: boolean;
  shadowed: boolean;
  writeEnabled: boolean;
  blockedReason?: string;
}

export interface Finding {
  kind: string;
  campaignId?: number;
  accountId?: number;
  email?: string;
  detail: string;
  at?: string;
}

export interface SlimCampaign {
  id: number;
  name: string;
  status: string;
  clientId: number | null;
  minTimeBtwnEmails?: number | null;
  enableAiEspMatching?: boolean | null;
  sendAsPlainText?: boolean | null;
  trackSettings?: string[] | null;
  timezone?: string | null;
  daysOfTheWeek?: number[] | null;
  startHour?: string | null;
  endHour?: string | null;
  maxLeadsPerDay?: number | null;
}

export interface SlimAccount {
  id: number;
  email: string;
  fromName: string;
  clientId: number | null;
  campaignIds: number[];
  tags: string[];
  smtpOk: boolean;
  imapOk: boolean;
  messagePerDay: number | null;
  warmupBlocked: boolean;
  createdAt: string | null;
  warmupStartedAt: string | null;
  signature: string;
  inboxkitWarmedAt?: string | null;
}

export interface SlimClient {
  id: number;
  name?: string | null;
  logo?: string | null;
}

export interface InventoryBook {
  fetchedAt: string;
  campaigns: SlimCampaign[];
  accounts: SlimAccount[];
  /** Smartlead client records: the only source of the signature brand line. */
  clients?: SlimClient[];
}

export interface PlacementScore {
  campaignId: number;
  campaignName?: string;
  source: "canary-copy" | "live-placement";
  testId: string;
  inboxPercent: number;
  scoredAt: string;
  fleetEmailsScored: number;
  releasedEmailsIgnored: number;
  canaryKind?: CanaryKind;
  failureClass?: FailureClass;
}

export interface EspInboxDay {
  campaignId: number;
  campaignName?: string;
  day: string;
  gToG: number | null;
  msToMs: number | null;
  testId?: string;
  source?: "canary-copy" | "live-placement";
}

export interface QaRun {
  id: string;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  role: QaRole;
  status: QaRunStatus;
  trigger: QaTrigger;
  campaignId?: number;
  detail?: string;
  findings?: Finding[];
}

export interface SeatHold {
  accountId: number;
  email: string;
  reason: "tenant_rate_limit" | "tenant_outbound_block" | "smtp_imap";
  evidence: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface TerlSubstitution {
  campaignId: number;
  stoppedAccountId: number;
  stoppedEmail: string;
  substituteAccountId: number | null;
  substituteEmail: string | null;
  clientId: number | null;
  tenant: string;
  stoppedAt: string;
  restoreAfter: string;
  restoredAt: string | null;
  noSubstitute: boolean;
}

export interface SequenceSample {
  campaignId: number;
  body: string;
  delayInDays?: number | null;
}

export interface LeadSample {
  campaignId: number;
  customFields?: Record<string, string | null | undefined>;
}

export interface IsolationSuspect {
  campaignId: number;
  campaignName?: string;
  source: "canary-copy" | "live-placement";
  testId?: string;
  queuedAt: string;
  evaluatedAt?: string;
}

export interface IsolationRun {
  id: string;
  campaignId: number;
  verdict: "COPY" | "INFRA" | "INCONCLUSIVE" | "HEALTHY";
  reason: string;
  startedAt: string;
  finishedAt?: string;
  teardownStarted: boolean;
}

export interface GenericSeat {
  accountId: number;
  email: string;
  assignedClientId: number | null;
  assignedPod: Pod | null;
  assignedAt: string | null;
  releasedAt: string | null;
  reason: string | null;
}

export interface ProviderSplit {
  name: string;
  inboxPercent: number;
  emails: string[];
}

export interface SpamTest {
  id: string;
  name: string;
  campaignId?: string;
  status?: string;
  senders?: Array<{ email: string; inbox?: boolean; provider?: string }>;
  /** Same-ESP splits from providerwise when sender rows are missing. */
  providers?: ProviderSplit[];
}

export interface StageStamp {
  stage: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  inFlightSince?: string;
  lastSkipReason?: string;
}

export interface OldWizardHealth {
  canonCompliant?: boolean;
  canonFindings?: Record<string, number>;
  placementIsolation?: {
    scored?: number;
    ugly?: number;
    uglyWithoutIsolation?: Array<{
      campaignId: number;
      campaignName?: string;
      source?: string;
      inboxPercent?: number;
    }>;
  };
  campaigns?: Array<{ campaignId: number; name?: string; yes?: boolean; fails?: string[] }>;
}
