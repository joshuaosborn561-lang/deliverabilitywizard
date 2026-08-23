import type { MailboxControlPlacement, MailboxControlTag } from "../lib/mailboxControlTag.js";
import type { IsolationVerdict } from "../lib/isolationVerdict.js";
import type { VariantKind } from "../lib/copyVariants.js";
import type { SuppressedTerm } from "../lib/suppressedTerms.js";
import type { PodPool, PodStatus } from "../lib/pods.js";

export interface IsolationControlTemplateRecord {
  controlVersion: string;
  subject: string;
  bodyText: string;
  createdAt: string;
}

export interface IsolationFolderRecord {
  podControls?: string | number;
  teardowns?: string | number;
}

export interface IsolationPodRecord {
  id: string;
  name: string;
  pool: PodPool;
  status: PodStatus;
  clientId: number | null;
  mailboxIds: number[];
  emails: string[];
  updatedAt: string;
}

export interface PodControlRecord {
  id: string;
  podId: string;
  controlVersion: string;
  spamTestId: string;
  folderId?: string | number;
  emails: string[];
  createdAt: string;
  lastReadAt?: string;
  primaryPct?: number;
  spamPct?: number;
  verdict?: "CLEAN" | "DEGRADED" | "FAILING" | "INSUFFICIENT";
  sendersTested?: number;
  sendersFailing?: number;
  infraDetails?: Record<string, unknown>;
}

export interface MailboxControlResultRecord {
  email: string;
  mailboxId?: number;
  podId?: string;
  lastTestId?: string;
  ranAt: string;
  placement: MailboxControlPlacement;
  inboxRate?: number;
  scoredSameEsp?: boolean;
  history: MailboxControlPlacement[];
  rollingFailCount: number;
  tag: MailboxControlTag;
}

export interface IsolationDomainRecord {
  domain: string;
  mailboxIds: number[];
  emails: string[];
  status: "configured" | "baselined" | "failed";
  baselinedAt?: string;
  lastControlTestId?: string;
  lastControlPrimary?: boolean;
}

export interface IsolationRunRecord {
  id: string;
  campaignId: number;
  campaignName?: string;
  client?: string;
  startedAt: string;
  updatedAt: string;
  control: "CLEAN" | "FAILING" | "INSUFFICIENT";
  verdict: IsolationVerdict;
  campaignInSpam: boolean;
  reason: string;
  controlTestId?: string;
  suspectTestId?: string;
  infraCheck?: Record<string, unknown>;
  seedsConsumed?: number;
  notes?: string;
  teardownStarted?: boolean;
}

export interface IsolationVariantRecord {
  id: string;
  runId: string;
  campaignId: number;
  kind: VariantKind;
  element: string;
  subject: string;
  body: string;
  spamTestId?: string;
  primaryPct?: number;
  spamPct?: number;
  recovered?: boolean;
  createdAt: string;
}

export interface CopySuspectRecord {
  campaignId: number;
  campaignName?: string;
  at: string;
  evaluatedAt?: string;
}

export type IsolationActionKind =
  | "retire_domain"
  | "buy_domains"
  | "swap_copy";

export type IsolationActionStatus =
  | "pending"
  | "approved"
  | "denied"
  | "executed"
  | "failed";

export interface IsolationActionRecord {
  id: string;
  kind: IsolationActionKind;
  status: IsolationActionStatus;
  title: string;
  proof: string;
  detail: Record<string, unknown>;
  allowed: "owner" | "owner_or_operator";
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  executedAt?: string;
  error?: string;
}

export interface DomainControlHistoryRecord {
  domain: string;
  fleet: boolean;
  consecutiveFails: number;
  status: "ok" | "watch" | "retire_pending" | "retired";
  readings: Array<{
    at: string;
    domainFailed: boolean;
    failingEmails: string[];
    testedEmails: string[];
  }>;
  lastReason?: string;
  retiredAt?: string;
}

export interface IsolationState {
  controlTemplate: IsolationControlTemplateRecord | null;
  folders: IsolationFolderRecord;
  pods: Record<string, IsolationPodRecord>;
  podControls: Record<string, PodControlRecord>;
  mailboxResults: Record<string, MailboxControlResultRecord>;
  isolationDomain: IsolationDomainRecord | null;
  runs: Record<string, IsolationRunRecord>;
  variants: Record<string, IsolationVariantRecord>;
  suppressedTerms: Record<string, SuppressedTerm>;
  copySuspects: Record<string, CopySuspectRecord>;
  lastPodControlAt: string | null;
  lastDeliveryWatchAt: string | null;
  lastRigBaselineAt: string | null;
  domainHistory: Record<string, DomainControlHistoryRecord>;
  actions: Record<string, IsolationActionRecord>;
}

export const EMPTY_ISOLATION_STATE: IsolationState = {
  controlTemplate: null,
  folders: {},
  pods: {},
  podControls: {},
  mailboxResults: {},
  isolationDomain: null,
  runs: {},
  variants: {},
  suppressedTerms: {},
  copySuspects: {},
  lastPodControlAt: null,
  lastDeliveryWatchAt: null,
  lastRigBaselineAt: null,
  domainHistory: {},
  actions: {},
};

export function normalizeIsolationState(
  raw: Partial<IsolationState> | null | undefined,
): IsolationState {
  return {
    ...EMPTY_ISOLATION_STATE,
    ...(raw ?? {}),
    folders: raw?.folders ?? {},
    pods: raw?.pods ?? {},
    podControls: raw?.podControls ?? {},
    mailboxResults: raw?.mailboxResults ?? {},
    isolationDomain: raw?.isolationDomain ?? null,
    runs: raw?.runs ?? {},
    variants: raw?.variants ?? {},
    suppressedTerms: raw?.suppressedTerms ?? {},
    copySuspects: raw?.copySuspects ?? {},
    controlTemplate: raw?.controlTemplate ?? null,
    lastPodControlAt: raw?.lastPodControlAt ?? null,
    lastDeliveryWatchAt: raw?.lastDeliveryWatchAt ?? null,
    lastRigBaselineAt: raw?.lastRigBaselineAt ?? null,
    domainHistory: raw?.domainHistory ?? {},
    actions: raw?.actions ?? {},
  };
}
