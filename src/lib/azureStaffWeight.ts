/**
 * D232 — Azure/Entra seats weigh 0.1 toward a POD's 40; every other
 * type weighs 1. Shared helpers for staffable sums and the read-only
 * per-client per-POD coverage report.
 */

import { accountEmail, campaignIdsOf } from "../clients/smartlead.js";
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isClientInbox, isGenericMailbox } from "./clientInbox.js";
import { isStaffableSender } from "./staffableSender.js";
import { owesWarmup } from "../services/warmupGate.js";
import {
  classifyMailboxSendType,
  mailboxStaffableWeight,
  roundStaffableWeight,
  weightedStaffableShortfall,
} from "./mailboxType.js";
import { podFromMailboxTags, type GenericAssignedPod } from "./genericPool.js";
import { assignClientCohorts } from "./restCohort.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";

export interface AzureWeightedPodRow {
  clientId: number;
  clientName: string;
  pod: GenericAssignedPod;
  weightedTotal: number;
  shortfall: number;
  nonAzureWarmPoolAvailable: number;
}

export function weightedStaffableOnCampaign(input: {
  campaignId: number;
  accounts: SmartleadAccountWithCampaigns[];
  excludeAccountIds?: Iterable<number>;
  isCopyCanary?: (email: string) => boolean;
}): number {
  const skip = new Set(
    [...(input.excludeAccountIds ?? [])].filter((id) => Number.isFinite(id)),
  );
  let total = 0;
  for (const account of input.accounts) {
    if (typeof account.id === "number" && skip.has(account.id)) continue;
    if (!campaignIdsOf(account).includes(input.campaignId)) continue;
    const email = accountEmail(account);
    if (!email) continue;
    if (
      !isStaffableSender(account, {
        copyCanary: Boolean(input.isCopyCanary?.(email)),
      })
    ) {
      continue;
    }
    total = roundStaffableWeight(total + mailboxStaffableWeight(account));
  }
  return total;
}

function podOfNamed(
  account: SmartleadAccountWithCampaigns,
  email: string,
  cohorts: ReadonlyMap<string, "A" | "B">,
): GenericAssignedPod | null {
  return podFromMailboxTags(account.tags) ?? cohorts.get(email) ?? null;
}

export function azureWeightedPodReport(input: {
  accounts: SmartleadAccountWithCampaigns[];
  campaigns: Array<Pick<SmartleadCampaign, "id" | "client_id" | "status" | "name">>;
  clients: Array<{ id: number; name?: string | null }>;
  config: Pick<
    AppConfig,
    | "extraGenericMailboxes"
    | "extraGenericDomains"
    | "prewarmedDomains"
    | "campaignMinWarmupDays"
    | "freshInboxWarmupDays"
  >;
  state: Pick<StateStore, "isCopyCanary" | "getPoolMailbox">;
  now?: Date;
}): AzureWeightedPodRow[] {
  const namedByClient = new Map<
    number,
    Array<{ email: string; type?: string | null }>
  >();
  const namedAccounts = new Map<string, SmartleadAccountWithCampaigns>();
  const weighted = new Map<string, number>();
  const bump = (clientId: number, pod: GenericAssignedPod, weight: number): void => {
    const key = `${clientId}:${pod}`;
    weighted.set(key, roundStaffableWeight((weighted.get(key) ?? 0) + weight));
  };

  const activeClients = new Set<number>();
  for (const campaign of input.campaigns) {
    if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") continue;
    if (typeof campaign.client_id === "number") activeClients.add(campaign.client_id);
  }

  for (const account of input.accounts) {
    const email = accountEmail(account);
    if (!email) continue;
    if (
      !isStaffableSender(account, {
        copyCanary: Boolean(input.state.isCopyCanary?.(email)),
      })
    ) {
      continue;
    }
    const generic = isGenericMailbox(account, email, input.config, input.state);
    const clientId =
      typeof account.client_id === "number" && account.client_id > 0
        ? account.client_id
        : null;
    if (!generic) {
      if (!isClientInbox(account, email, input.config, input.state)) continue;
      if (clientId == null) continue;
      const list = namedByClient.get(clientId) ?? [];
      list.push({ email, type: account.type });
      namedByClient.set(clientId, list);
      namedAccounts.set(email, account);
      continue;
    }
    if (clientId == null || !activeClients.has(clientId)) continue;
    const pod = podFromMailboxTags(account.tags);
    if (!pod) continue;
    bump(clientId, pod, mailboxStaffableWeight(account));
  }

  for (const [clientId, rows] of namedByClient) {
    const untagged = rows.filter((row) => {
      const account = namedAccounts.get(row.email);
      return podFromMailboxTags(account?.tags) == null;
    });
    const cohorts = assignClientCohorts(untagged);
    for (const row of rows) {
      const account = namedAccounts.get(row.email);
      if (!account) continue;
      const pod = podOfNamed(account, row.email, cohorts);
      if (!pod) continue;
      bump(clientId, pod, mailboxStaffableWeight(account));
    }
  }

  let nonAzureWarmPool = 0;
  for (const account of input.accounts) {
    const email = accountEmail(account);
    if (!email) continue;
    if (!isGenericMailbox(account, email, input.config, input.state)) continue;
    if (typeof account.client_id === "number" && account.client_id > 0) continue;
    if (classifyMailboxSendType(account) === "azure") continue;
    if (
      !isStaffableSender(account, {
        copyCanary: Boolean(input.state.isCopyCanary?.(email)),
      })
    ) {
      continue;
    }
    if (owesWarmup(account, email, input.config, input.state)) {
      continue;
    }
    nonAzureWarmPool += 1;
  }

  const names = new Map(input.clients.map((row) => [row.id, String(row.name ?? row.id)]));
  const rows: AzureWeightedPodRow[] = [];
  const clientIds = new Set<number>([
    ...activeClients,
    ...[...weighted.keys()].map((key) => Number(key.split(":")[0])),
  ]);
  for (const clientId of [...clientIds].sort((a, b) => a - b)) {
    for (const pod of ["A", "B"] as const) {
      const total = weighted.get(`${clientId}:${pod}`) ?? 0;
      rows.push({
        clientId,
        clientName: names.get(clientId) ?? String(clientId),
        pod,
        weightedTotal: total,
        shortfall: weightedStaffableShortfall(total),
        nonAzureWarmPoolAvailable: nonAzureWarmPool,
      });
    }
  }
  return rows;
}
