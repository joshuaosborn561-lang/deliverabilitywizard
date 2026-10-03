/**
 * D225 — apply surplus generic returns from min40-topup and
 * generic-cleanup. Unlink, clear client_id, reset signature,
 * clear the generics table assignment.
 */

import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import type { SmartleadCampaign } from "../types/index.js";
import {
  accountIsPeelStaffable,
  detachWouldBreakStaffableFloor,
} from "../lib/clientStaffFloor.js";
import { GENERIC_POOL_POWERGRYD_CLIENT_ID } from "../lib/genericPool.js";
import {
  syncGenericSeatsFromInventory,
  type GenericPoolSyncAccount,
} from "../lib/genericPoolCanon.js";
import {
  openTerlSubstituteEmails,
  surplusGenericReturns,
} from "../lib/genericSurplusReturn.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import {
  dropMembership,
  type InventorySnapshot,
} from "./inventory.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 200;

export interface SurplusGenericReturn {
  email: string;
  clientId: number;
  unlinked: number[];
}

export interface SurplusGenericReturnResult {
  skipped?: boolean;
  reason?: string;
  returned: SurplusGenericReturn[];
  errors: string[];
}

function campaignIsActive(campaign: { status?: string | null } | undefined): boolean {
  const status = String(campaign?.status ?? "").toUpperCase();
  return status === "ACTIVE" || status === "START";
}

function staffableOnCampaign(
  campaignId: number,
  accounts: SmartleadAccountWithCampaigns[],
  state: Pick<StateStore, "getRestingInbox" | "isCopyCanary">,
): number {
  let n = 0;
  for (const account of accounts) {
    if (!campaignIdsOf(account).includes(campaignId)) continue;
    const email = accountEmail(account);
    if (!email) continue;
    if (
      accountIsPeelStaffable(account, email, {
        getRestingInbox: (key) => state.getRestingInbox(key),
        isCopyCanary: (key) => state.isCopyCanary(key),
      })
    ) {
      n += 1;
    }
  }
  return n;
}

export async function returnSurplusGenerics(input: {
  config: Pick<
    AppConfig,
    | "extraGenericMailboxes"
    | "extraGenericDomains"
    | "prewarmedDomains"
    | "powerGrydClientId"
    | "dryRun"
  >;
  smartlead: Pick<
    SmartleadClient,
    "removeEmailAccountsFromCampaign" | "updateEmailAccount"
  >;
  state: StateStore;
  inventory: InventorySnapshot;
  dryRun?: boolean;
  now?: Date;
}): Promise<SurplusGenericReturnResult> {
  const now = input.now ?? new Date();
  const dryRun = input.dryRun ?? input.config.dryRun;
  const result: SurplusGenericReturnResult = { returned: [], errors: [] };
  const powerId =
    input.config.powerGrydClientId || GENERIC_POOL_POWERGRYD_CLIENT_ID;
  const skip = openTerlSubstituteEmails(
    input.state.listActiveTerlSubstitutions(),
    now,
  );
  const synced = syncGenericSeatsFromInventory({
    existing: input.state.listGenericSeats(),
    accounts: input.inventory.accounts as GenericPoolSyncAccount[],
    campaigns: input.inventory.campaigns,
    config: input.config,
    state: input.state,
    now,
    powerGrydClientId: powerId,
  });
  const picks = surplusGenericReturns({
    seats: synced.seats,
    namedStaffableByClientPod: synced.namedStaffableByClientPod,
    clientHasActiveCampaign: synced.clientHasActiveCampaign,
    campaignClientById: synced.campaignClientById,
    liveClientIdsByEmail: synced.liveClientIdsByEmail,
    powerGrydClientId: powerId,
    skipEmails: skip,
    now,
  });
  if (!picks.length) return result;

  const accounts = input.inventory.accounts as SmartleadAccountWithCampaigns[];
  const campaignById = new Map(
    (input.inventory.campaigns as SmartleadCampaign[]).map((row) => [row.id, row]),
  );
  const accountByEmail = new Map(
    accounts
      .map((account) => [accountEmail(account)?.toLowerCase(), account] as const)
      .filter((row): row is [string, SmartleadAccountWithCampaigns] => Boolean(row[0])),
  );

  if (!dryRun) {
    input.state.replaceGenericSeats(synced.seats);
  }

  for (const pick of picks) {
    const account = accountByEmail.get(pick.email);
    if (!account || typeof account.id !== "number") continue;
    if (account.client_id === powerId) continue;

    const campaignIds = campaignIdsOf(account);
    let blocked = false;
    for (const campaignId of campaignIds) {
      const campaign = campaignById.get(campaignId);
      if (!campaign || !campaignIsActive(campaign)) continue;
      const remaining = staffableOnCampaign(campaignId, accounts, input.state);
      if (
        detachWouldBreakStaffableFloor(campaign, remaining, account, pick.email, {
          getRestingInbox: (key) => input.state.getRestingInbox(key),
          isCopyCanary: (key) => input.state.isCopyCanary(key),
        })
      ) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const unlinked: number[] = [];
    try {
      if (!dryRun) {
        for (const campaignId of campaignIds) {
          await input.smartlead.removeEmailAccountsFromCampaign(campaignId, [
            account.id,
          ]);
          dropMembership(account, campaignId);
          unlinked.push(campaignId);
          await sleep(WRITE_GAP_MS);
        }
        await input.smartlead.updateEmailAccount(account.id, {
          client_id: null,
          signature: "",
        });
        await sleep(WRITE_GAP_MS);
        const pool = input.state.getPoolMailbox(pick.email);
        if (pool) {
          input.state.upsertPoolMailbox({
            ...pool,
            assignedClientId: undefined,
            assignedClientName: undefined,
            assignedAt: undefined,
            status: pool.status === "assigned" ? "available" : pool.status,
          });
        }
        input.state.clearGenericSeatAssignment(pick.email);
        account.client_id = null;
        account.signature = "";
      } else {
        unlinked.push(...campaignIds);
      }
      result.returned.push({
        email: pick.email,
        clientId: pick.clientId,
        unlinked,
      });
      console.log(
        `[generic-surplus] returned ${pick.email} from client ${pick.clientId} (unlinked ${unlinked.length})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${pick.email}: ${message}`);
    }
  }

  return result;
}
