import { isGenericMailbox } from "./clientInbox.js";
import {
  isOffWeek,
  resolveClientCohorts,
  type RestCohort,
} from "./restCohort.js";
import { isIsolationEmail, type IsolationDenylist } from "./isolationDomain.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";

export type PodPool = "A" | "B" | "generic_sending" | "generic_resting";
export type PodStatus = "active" | "resting";

export interface PodMailbox {
  accountId: number;
  email: string;
  clientId: number | null;
  clientName: string;
}

export interface Pod {
  id: string;
  name: string;
  pool: PodPool;
  status: PodStatus;
  clientId: number | null;
  clientName?: string;
  mailboxes: PodMailbox[];
}

export interface PodAccountInput {
  accountId: number;
  email: string;
  clientId: number | null;
  clientName: string;
  fromName?: string;
  onActiveCampaign: boolean;
  resting: boolean;
  /** D68 — existing Smartlead POD-A / POD-B tag, when present. */
  pod?: RestCohort | null;
}

export function clientPodId(clientId: number | string, cohort: RestCohort): string {
  return `client:${clientId}:${cohort}`;
}

export function genericPodId(kind: "sending" | "resting"): string {
  return `generic:${kind}`;
}

export function buildPods(input: {
  accounts: PodAccountInput[];
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains">;
  state: Pick<StateStore, "getPoolMailbox">;
  isolation: Pick<IsolationDenylist, "emails" | "domain">;
  now?: Date;
}): Pod[] {
  const now = input.now ?? new Date();
  const byClient = new Map<string, PodAccountInput[]>();
  const genericSending: PodMailbox[] = [];
  const genericResting: PodMailbox[] = [];

  for (const account of input.accounts) {
    const email = account.email.trim().toLowerCase();
    if (!email.includes("@")) continue;
    if (isIsolationEmail(email, input.isolation)) continue;

    const row: PodMailbox = {
      accountId: account.accountId,
      email,
      clientId: account.clientId,
      clientName: account.clientName,
    };

    const generic = isGenericMailbox(
      { client_id: account.clientId, from_name: account.fromName },
      email,
      input.config,
      input.state,
    );

    if (generic) {
      if (account.resting) genericResting.push(row);
      else if (account.onActiveCampaign) genericSending.push(row);
      continue;
    }

    if (!account.onActiveCampaign && !account.resting) continue;
    const clientKey =
      account.clientId != null ? String(account.clientId) : `name:${account.clientName}`;
    const list = byClient.get(clientKey) ?? [];
    list.push(account);
    byClient.set(clientKey, list);
  }

  const pods: Pod[] = [];

  for (const [clientKey, accounts] of byClient) {
    const cohorts = resolveClientCohorts(
      accounts.map((account) => ({
        email: account.email,
        tagged: account.pod ?? null,
      })),
    );
    const grouped: Record<RestCohort, PodMailbox[]> = { A: [], B: [] };
    for (const account of accounts) {
      const cohort = cohorts.get(account.email.trim().toLowerCase());
      if (!cohort) continue;
      grouped[cohort].push({
        accountId: account.accountId,
        email: account.email.trim().toLowerCase(),
        clientId: account.clientId,
        clientName: account.clientName,
      });
    }

    const clientId = accounts[0]?.clientId ?? null;
    const clientName = accounts[0]?.clientName ?? clientKey;
    for (const cohort of ["A", "B"] as RestCohort[]) {
      if (!grouped[cohort].length) continue;
      const resting = isOffWeek(cohort, now);
      pods.push({
        id: clientPodId(clientKey, cohort),
        name: `${clientName} ${cohort}`,
        pool: cohort,
        status: resting ? "resting" : "active",
        clientId,
        clientName,
        mailboxes: grouped[cohort],
      });
    }
  }

  if (genericSending.length) {
    pods.push({
      id: genericPodId("sending"),
      name: "Generic sending",
      pool: "generic_sending",
      status: "active",
      clientId: null,
      mailboxes: genericSending,
    });
  }
  if (genericResting.length) {
    pods.push({
      id: genericPodId("resting"),
      name: "Generic sitting",
      pool: "generic_resting",
      status: "resting",
      clientId: null,
      mailboxes: genericResting,
    });
  }

  return pods.sort((a, b) => a.id.localeCompare(b.id));
}

export function emailsForPod(pod: Pod): string[] {
  return pod.mailboxes.map((mailbox) => mailbox.email);
}

export function findPodsForEmails(pods: Pod[], emails: string[]): Pod[] {
  const wanted = new Set(emails.map((email) => email.trim().toLowerCase()));
  return pods.filter((pod) =>
    pod.mailboxes.some((mailbox) => wanted.has(mailbox.email)),
  );
}

export function placementsForCampaignSenders<T>(
  byEmail: Map<string, T>,
  campaignEmails: string[],
): T[] {
  const out: T[] = [];
  for (const email of campaignEmails) {
    const row = byEmail.get(email.trim().toLowerCase());
    if (row !== undefined) out.push(row);
  }
  return out;
}
