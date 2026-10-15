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
  | "tag";

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

export interface InventoryBook {
  fetchedAt: string;
  campaigns: SlimCampaign[];
  accounts: SlimAccount[];
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
}

export interface StageStamp {
  stage: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  inFlightSince?: string;
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
