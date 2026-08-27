import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import {
  brandFromClientDisplayName,
  clientBrandList,
  findForeignBrand,
} from "../lib/clientBrand.js";
import { isGenericMailbox } from "../lib/clientInbox.js";
import { campaignMayTakeGenerics } from "../lib/genericBackfill.js";
import { pocClientId } from "../lib/pocClient.js";
import { isolationEmailsOf, isIsolationEmail } from "../lib/isolationDomain.js";
import { desiredMailboxSignature } from "../lib/mailboxSignature.js";
import { foreignCampaignIds, ownerClientId, type MembershipRow } from "../lib/oneClient.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { sleep } from "../lib/http.js";
import { signatureHay } from "../lib/signatureQa.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import {
  dropMembership,
  fetchInventory,
  recordMembership,
  type InventorySnapshot,
} from "./inventory.js";

const WRITE_BATCH = 25;
const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 400;

export interface OneClientMembershipResult {
  dryRun: boolean;
  examined: number;
  pulled: Array<{ email: string; campaignId: number }>;
  restored: Array<{ email: string; campaignId: number }>;
  signaturesSet: number;
  skipped: string[];
  errors: string[];
}

interface AccountPlan {
  email: string;
  accountId: number;
  owner: number;
  pull: number[];
  restore: number[];
  signature?: string;
  /** D142 — marker-client boxes keep their Generic/POC client_id. */
  keepClientId?: boolean;
}

/**
 * D75 / D76 — every health pass: an inbox may only sit on one client's
 * campaigns. Generics belong to Goliath even with a leftover client_id.
 * The paused pod-control shell does not count. Signature is rewritten to
 * the owner client's brand when a leftover line is another client.
 */
export class OneClientMembershipService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot } = {},
  ): Promise<OneClientMembershipResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: OneClientMembershipResult = {
      dryRun,
      examined: 0,
      pulled: [],
      restored: [],
      signaturesSet: 0,
      skipped: [],
      errors: [],
    };

    const { campaigns, accounts, clients } =
      opts.inventory ?? (await fetchInventory(this.smartlead));
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((campaign) => [campaign.id, campaign]),
    );
    const brandByClientId = new Map<number, string>();
    const clientsById = new Map(clients.map((client) => [client.id, client]));
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }
    const allBrands = clientBrandList(clients);
    const isolation = {
      emails: isolationEmailsOf(this.config.isolationMailboxEmails),
      domain: this.config.isolationDomain || undefined,
    };
    const genericOwnerId = pocClientId(clients, this.config.pocClientNamePatterns);
    const approvals =
      typeof this.state.listGenericBackfillApprovals === "function"
        ? this.state.listGenericBackfillApprovals()
        : {};
    const activeOwnerCampaignIds = (campaigns as SmartleadCampaign[])
      .filter((campaign) => {
        if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") return false;
        if (isAnyShellCampaign(campaign)) return false;
        const client =
          typeof campaign.client_id === "number"
            ? clientsById.get(campaign.client_id)
            : undefined;
        return campaignMayTakeGenerics(
          campaign,
          client ? clientDisplayName(client) : "",
          this.config.pocClientNamePatterns,
          approvals,
        );
      })
      .map((campaign) => campaign.id);

    const plans: AccountPlan[] = [];

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (this.state.isCopyCanary(email)) continue;
      if (isIsolationEmail(email, isolation)) continue;

      const memberships: MembershipRow[] = campaignIdsOf(account).map((id) => {
        const campaign = campaignById.get(id);
        return {
          campaignId: id,
          clientId:
            typeof campaign?.client_id === "number" ? campaign.client_id : null,
          shell: campaign ? isAnyShellCampaign(campaign) : false,
        };
      });
      if (!memberships.length) continue;
      result.examined += 1;

      const generic = isGenericMailbox(account, email, this.config, this.state);
      // D142 — a Generic/POC marker client_id is a deliberate pool
      // assignment, not a leftover tag: never rewrite it back to the POC
      // client's id. Memberships still resolve through the POC owner.
      const markerOwned =
        typeof account.client_id === "number" &&
        this.state.isMarkerClientId(account.client_id);
      const owner = ownerClientId(account.client_id, memberships, {
        generic,
        genericOwnerId,
      });
      if (owner == null) {
        result.skipped.push(`${email}: no single owner client`);
        continue;
      }

      const pull = foreignCampaignIds(owner, memberships);
      const onOwner = memberships.some(
        (row) => !row.shell && row.clientId === owner,
      );
      const leftoverTagged =
        generic &&
        !markerOwned &&
        typeof genericOwnerId === "number" &&
        typeof account.client_id === "number" &&
        account.client_id !== genericOwnerId;
      const needsGoliathIdentity =
        generic &&
        !markerOwned &&
        typeof genericOwnerId === "number" &&
        account.client_id !== genericOwnerId;
      // Shell-only leftover-tagged generics (Aarav after the first pass)
      // must go back on live Goliath, not sit on the paused shell.
      const restore =
        generic && !onOwner && (pull.length > 0 || leftoverTagged)
          ? activeOwnerCampaignIds.filter(
              (id) => !memberships.some((row) => row.campaignId === id),
            )
          : [];

      const clientBrand = brandByClientId.get(owner) ?? "";
      const hay = signatureHay({
        fromName: account.from_name,
        signature: account.signature,
      });
      const foreign = clientBrand
        ? findForeignBrand(hay, clientBrand, allBrands)
        : null;
      const desired = clientBrand
        ? desiredMailboxSignature({
            fromName: account.from_name,
            signature: account.signature,
            clientBrand,
            otherClientBrands: allBrands.filter((brand) => brand !== clientBrand),
          })
        : null;
      const needsSignature =
        Boolean(desired) &&
        (account.signature ?? "") !== desired &&
        (Boolean(foreign) || needsGoliathIdentity);

      if (!pull.length && !restore.length && !needsSignature) continue;
      plans.push({
        email,
        accountId: account.id,
        owner,
        pull,
        restore,
        signature: needsSignature && desired ? desired : undefined,
        keepClientId: markerOwned,
      });
    }

    const accountById = new Map(
      (accounts as SmartleadAccountWithCampaigns[])
        .filter((account) => typeof account.id === "number")
        .map((account) => [account.id, account]),
    );
    const removals = new Map<number, Array<{ email: string; accountId: number }>>();
    const restores = new Map<number, Array<{ email: string; accountId: number }>>();
    for (const plan of plans) {
      for (const campaignId of plan.restore) {
        const list = restores.get(campaignId) ?? [];
        list.push({ email: plan.email, accountId: plan.accountId });
        restores.set(campaignId, list);
      }
      for (const campaignId of plan.pull) {
        const list = removals.get(campaignId) ?? [];
        list.push({ email: plan.email, accountId: plan.accountId });
        removals.set(campaignId, list);
      }
    }

    // Restore onto the owner first so a generic is not left campaign-less.
    for (const [campaignId, rows] of restores) {
      for (const batch of chunk(rows, WRITE_BATCH)) {
        try {
          if (!dryRun) {
            await this.smartlead.addEmailAccountsToCampaign(
              campaignId,
              batch.map((row) => row.accountId),
            );
            await sleep(WRITE_GAP_MS);
            for (const row of batch) {
              const account = accountById.get(row.accountId);
              if (account) recordMembership(account, campaignId);
            }
          }
          for (const row of batch) {
            result.restored.push({ email: row.email, campaignId });
            console.log(
              `[one-client] ${row.email} onto #${campaignId} (Goliath restore)`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`add #${campaignId}: ${message}`);
        }
      }
    }

    for (const [campaignId, rows] of removals) {
      for (const batch of chunk(rows, WRITE_BATCH)) {
        try {
          if (!dryRun) {
            await this.smartlead.removeEmailAccountsFromCampaign(
              campaignId,
              batch.map((row) => row.accountId),
            );
            await sleep(WRITE_GAP_MS);
            for (const row of batch) {
              const account = accountById.get(row.accountId);
              if (account) dropMembership(account, campaignId);
            }
          }
          for (const row of batch) {
            result.pulled.push({ email: row.email, campaignId });
            console.log(
              `[one-client] ${row.email} off #${campaignId}`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`remove #${campaignId}: ${message}`);
        }
      }
    }

    for (const plan of plans) {
      if (!plan.signature) continue;
      try {
        if (!dryRun) {
          await this.smartlead.updateEmailAccount(plan.accountId, {
            signature: plan.signature,
            // D142 — never overwrite a deliberate Generic/POC assignment.
            ...(plan.keepClientId ? {} : { client_id: plan.owner }),
          });
          await sleep(WRITE_GAP_MS);
        }
        result.signaturesSet += 1;
        console.log(`[one-client] ${plan.email} signature → client ${plan.owner}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${plan.email} signature: ${message}`);
      }
    }

    console.log(
      `[one-client] examined=${result.examined} pulled=${result.pulled.length} restored=${result.restored.length} signatures=${result.signaturesSet} errors=${result.errors.length}`,
    );
    return result;
  }
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
