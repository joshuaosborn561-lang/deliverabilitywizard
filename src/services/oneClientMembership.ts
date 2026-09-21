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
import { resolveDedicatedGenericClientId } from "../lib/dedicatedGeneric.js";
import { campaignMayTakeGenerics } from "../lib/genericBackfill.js";
import { GENERIC_TAG } from "../lib/markerClients.js";
import { pocClientId } from "../lib/pocClient.js";
import { senderIsAttachBlocked } from "../lib/attachBlock.js";
import { isolationEmailsOf, isIsolationEmail } from "../lib/isolationDomain.js";
import { mailboxIsExclusiveInsightStaff } from "../lib/insightCampaigns.js";
import { desiredMailboxSignature } from "../lib/mailboxSignature.js";
import {
  countStaffableMemberships,
  detachWouldBreakStaffableFloor,
  noteStaffableDetach,
  ON_WEEK_MIN_SENDERS,
} from "../lib/clientStaffFloor.js";
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
  /** D160 — leftover Generic/POC client_id is cleared, never kept. */
  clearMarkerClientId?: boolean;
  /** D76 — leftover real-client id on a generic is rewritten to Goliath. */
  writeOwnerClientId?: boolean;
}

/**
 * D75 / D76 / D160 / D198 — every health pass: an inbox may only sit
 * on one client's campaigns. Rotating / undedicated generics belong to
 * Goliath (D76). A generic dedicated to a named client (mailbox
 * client_id, pool assignedClientId, or client:<id> tag) belongs to
 * that client — not Goliath — while it sits on that client's
 * campaigns (D198). A leftover Generic/POC client_id is cleared
 * (those are not clients). The paused pod-control shell does not
 * count. Signature is rewritten to the owner client's brand when a
 * leftover line is another client.
 *
 * D197 / D198 / D199 — do not pull a seat off an ACTIVE campaign
 * when that would drop the *staffable* attached count below 40.
 * Raw membership (disconnected leftovers) does not inflate the
 * floor. Dedicated named-client generics — including exclusive
 * attach + client-sig seats — are not foreign-pulled, not restored
 * onto Goliath, and not signature-rewritten to the POC brand even
 * above 40. Surplus *undedicated* rotating-pool generics above 40
 * may still come off. Multi-client links on a dedicated seat still
 * peel the foreign camp (floor-gated).
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
    // D193 — restore targets are POC (Goliath) ACTIVE campaigns only.
    // Leftover D134 approvals must not become a dump list for every
    // displaced generic (that restaffed TechEvo / BCP / SG overnight).
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
    const membershipCounts = countStaffableMemberships(
      accounts as SmartleadAccountWithCampaigns[],
      this.state,
    );

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (this.state.isCopyCanary(email)) continue;
      if (isIsolationEmail(email, isolation)) continue;
      if (
        senderIsAttachBlocked(
          { email, accountId: account.id },
          this.state,
        )
      ) {
        result.skipped.push(`${email}: attach blocked (D176)`);
        continue;
      }

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
      const dedicatedClientId = generic
        ? resolveDedicatedGenericClientId(
            account,
            email,
            memberships,
            this.state,
            { genericOwnerId, brandByClientId },
          )
        : null;
      // D160 — a leftover Generic/POC client_id is a billable pool label
      // we are draining, not an owner. Memberships still resolve through
      // the POC owner (Goliath). A generic with no client_id stays bare.
      const leftoverMarker =
        typeof account.client_id === "number" &&
        this.state.isMarkerClientId(account.client_id);
      // D198 — a named-client dedication is assignment, not a stale
      // Goliath leftover. Only undedicated rotating-pool leftovers
      // rewrite identity back to the POC.
      const leftoverReal =
        generic &&
        dedicatedClientId == null &&
        !leftoverMarker &&
        typeof genericOwnerId === "number" &&
        typeof account.client_id === "number" &&
        account.client_id !== genericOwnerId;
      const owner = ownerClientId(account.client_id, memberships, {
        generic,
        genericOwnerId,
        dedicatedClientId,
      });
      if (owner == null) {
        result.skipped.push(`${email}: no single owner client`);
        continue;
      }

      const rawPull = foreignCampaignIds(owner, memberships);
      const pull: number[] = [];
      let protectedByMin = false;
      for (const campaignId of rawPull) {
        const remaining = membershipCounts.get(campaignId) ?? 0;
        if (
          detachWouldBreakStaffableFloor(
            campaignById.get(campaignId),
            remaining,
            account,
            email,
            this.state,
          )
        ) {
          protectedByMin = true;
          result.skipped.push(
            `${email}: #${campaignId} at on-week min ${ON_WEEK_MIN_SENDERS} (D199)`,
          );
          continue;
        }
        pull.push(campaignId);
        noteStaffableDetach(
          membershipCounts,
          campaignId,
          account,
          email,
          this.state,
        );
      }
      const onOwner = memberships.some(
        (row) => !row.shell && row.clientId === owner,
      );
      // D197 — a floor-protected exclusive seat stays on the named client.
      // Do not also dump it onto Goliath or rewrite its client signature.
      const leftoverTagged = leftoverReal && !protectedByMin;
      const needsGoliathIdentity = leftoverReal && !protectedByMin;
      // Shell-only leftover-tagged generics (Aarav after the first pass)
      // must go back on live Goliath, not sit on the paused shell.
      // D198 — dedicated named-client seats never dump onto Goliath.
      const restore =
        generic &&
        dedicatedClientId == null &&
        !onOwner &&
        (pull.length > 0 || leftoverTagged)
          ? activeOwnerCampaignIds.filter((id) => {
              if (memberships.some((row) => row.campaignId === id)) return false;
              const campaign = campaignById.get(id);
              // D193 — never restore a generic onto another client's id,
              // even when the campaign name still matches a POC pattern.
              if (
                typeof campaign?.client_id === "number" &&
                campaign.client_id !== owner
              ) {
                return false;
              }
              return true;
            })
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
      // D184 — do not rewrite exclusive Insight mailboxes to SalesGlider.
      const exclusiveInsight = mailboxIsExclusiveInsightStaff(
        account,
        campaignById,
      );
      const needsSignature =
        !exclusiveInsight &&
        dedicatedClientId == null &&
        !protectedByMin &&
        Boolean(desired) &&
        (account.signature ?? "") !== desired &&
        (Boolean(foreign) || needsGoliathIdentity);

      if (
        !pull.length &&
        !restore.length &&
        !needsSignature &&
        !leftoverMarker
      ) {
        continue;
      }
      plans.push({
        email,
        accountId: account.id,
        owner,
        pull,
        restore,
        signature: needsSignature && desired ? desired : undefined,
        clearMarkerClientId: leftoverMarker,
        writeOwnerClientId: leftoverReal && !protectedByMin,
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
      if (!plan.signature && !plan.clearMarkerClientId) continue;
      try {
        if (!dryRun) {
          if (plan.clearMarkerClientId) {
            const tag = await this.smartlead.ensureTag(GENERIC_TAG, "#66BB6A");
            await this.smartlead.assignTags([plan.accountId], [tag.id]);
            await sleep(WRITE_GAP_MS);
          }
          await this.smartlead.updateEmailAccount(plan.accountId, {
            ...(plan.signature ? { signature: plan.signature } : {}),
            ...(plan.clearMarkerClientId
              ? { client_id: null }
              : plan.writeOwnerClientId
                ? { client_id: plan.owner }
                : {}),
          });
          await sleep(WRITE_GAP_MS);
        }
        if (plan.signature) {
          result.signaturesSet += 1;
          console.log(`[one-client] ${plan.email} signature → client ${plan.owner}`);
        }
        if (plan.clearMarkerClientId) {
          console.log(
            `[one-client] ${plan.email} cleared leftover Generic/POC client_id (D160)`,
          );
        }
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
