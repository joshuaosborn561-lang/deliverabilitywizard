import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import {
  clientAutoAllowsGenerics,
  POWERGRYD_CLIENT_ID,
} from "../lib/autoAllowGenerics.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { isGenericMailbox, isPoolGenericSeat } from "../lib/clientInbox.js";
import {
  ON_WEEK_MIN_SENDERS,
  POD_ESP_MIX_MIN_FRACTION,
  accountIsPeelStaffable,
} from "../lib/clientStaffFloor.js";
import { chicagoWallClock } from "../lib/canonOpsHours.js";
import {
  campaignHoldReason,
  holdPolicyFromConfig,
} from "../lib/holdPolicy.js";
import { requestGenericBackfillAsks } from "../lib/genericBackfillBatch.js";
import { senderIsAttachBlocked } from "../lib/attachBlock.js";
import { isRetiredSendingDomain } from "../lib/domainControl.js";
import { canAttachMailboxToCampaign } from "../lib/insightCampaigns.js";
import { isPocClient, pocClientId } from "../lib/pocClient.js";
import {
  buildPoolSignature,
  poolEspFromSmartleadType,
} from "../lib/poolSignature.js";
import { assignClientCohorts, onWeekCohort } from "../lib/restCohort.js";
import { mailboxMessagePerDayTarget } from "../lib/sendCeiling.js";
import { sleep } from "../lib/http.js";
import {
  INSIGHT_MAILBOX_SIGNATURE_BLANK,
  isInsightCampaignId,
} from "../lib/insightCampaigns.js";
import type { StateStore } from "../state/store.js";
import { owesWarmup } from "./warmupGate.js";
import { espFillOrder, isExcluded } from "./campaignTopUp.js";
import {
  dropMembership,
  fetchInventory,
  recordMembership,
  type InventorySnapshot,
} from "./inventory.js";
import { isPowerGrydClientId } from "./powerGrydWatch.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 250;

export interface Min40Assignment {
  campaignId: number;
  campaignName: string;
  email: string;
  clientId: number;
}

export interface Min40TopUpResult {
  dryRun: boolean;
  skipped?: boolean;
  reason?: string;
  assigned: Min40Assignment[];
  asked: Array<{ campaignId: number; name: string; shortBy: number }>;
  unfilled: Array<{ campaignId: number; name: string; shortBy: number }>;
  errors: string[];
}

function campaignIsActive(campaign: { status?: string | null } | undefined): boolean {
  const status = String(campaign?.status ?? "").toUpperCase();
  return status === "ACTIVE" || status === "START";
}

/**
 * D205 — named-client ACTIVE campaigns get the on-week POD to 40
 * without waiting for a human tap when the client is auto-allow.
 * Exclusive client-signed generics only. Never retag named seats.
 * PowerGRYD and standing holds are skipped.
 */
export class Min40TopUpService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot; now?: Date } = {},
  ): Promise<Min40TopUpResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: Min40TopUpResult = {
      dryRun,
      assigned: [],
      asked: [],
      unfilled: [],
      errors: [],
    };
    if (!this.config.enableMin40TopUp) {
      return { ...result, skipped: true, reason: "disabled" };
    }

    const { campaigns, accounts, clients } =
      opts.inventory ?? (await fetchInventory(this.smartlead));
    const now = opts.now ?? new Date();
    const policy = holdPolicyFromConfig(this.config);
    const todayYmd = chicagoWallClock(now, this.config.canonOpsTimezone).ymd;
    const onWeek = onWeekCohort(now);
    const clientsById = new Map(clients.map((c) => [c.id, c]));
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c]),
    );
    const accountById = new Map(
      (accounts as SmartleadAccountWithCampaigns[])
        .filter((account) => typeof account.id === "number")
        .map((account) => [account.id, account]),
    );
    const accountByEmail = new Map(
      (accounts as SmartleadAccountWithCampaigns[])
        .map((account) => [accountEmail(account)?.toLowerCase(), account] as const)
        .filter((row): row is [string, SmartleadAccountWithCampaigns] => Boolean(row[0])),
    );
    const brandByClientId = new Map<number, string>();
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }
    const namedOnWeek = this.namedOnWeekEmails(
      accounts as SmartleadAccountWithCampaigns[],
      campaigns as SmartleadCampaign[],
      clients,
      onWeek,
    );

    const askItems: Array<{ campaignId: number; campaignName: string; shortBy: number }> =
      [];

    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (!campaignIsActive(campaign)) continue;
      if (isAnyShellCampaign(campaign)) continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      if (campaignHoldReason(campaign, policy, todayYmd)) continue;
      const clientId = typeof campaign.client_id === "number" ? campaign.client_id : null;
      if (clientId == null) continue;
      if (isPowerGrydClientId(clientId, this.config.powerGrydClientId)) continue;
      const clientName = clientDisplayName(
        clientsById.get(clientId) ?? { id: clientId },
      );
      if (isPocClient(`${campaign.name ?? ""} ${clientName}`, this.config.pocClientNamePatterns)) {
        continue;
      }

      const staffable = this.countOnWeekStaffable(
        campaign.id,
        clientId,
        accounts as SmartleadAccountWithCampaigns[],
        namedOnWeek.get(clientId) ?? new Set(),
      );
      const shortBy = Math.max(0, ON_WEEK_MIN_SENDERS - staffable);
      if (shortBy <= 0) continue;

      const auto = clientAutoAllowsGenerics(
        clientId,
        this.config.autoAllowGenericClientIds,
      );
      if (!auto) {
        askItems.push({
          campaignId: campaign.id,
          campaignName: String(campaign.name ?? campaign.id),
          shortBy,
        });
        result.asked.push({
          campaignId: campaign.id,
          name: String(campaign.name ?? campaign.id),
          shortBy,
        });
        continue;
      }

      const placed = await this.fillCampaign({
        campaign,
        clientId,
        clientName,
        shortBy,
        dryRun,
        accounts: accounts as SmartleadAccountWithCampaigns[],
        campaignById,
        accountById,
        accountByEmail,
        brandByClientId,
        result,
      });
      if (placed < shortBy) {
        result.unfilled.push({
          campaignId: campaign.id,
          name: String(campaign.name ?? campaign.id),
          shortBy: shortBy - placed,
        });
      }
    }

    if (askItems.length && this.slack) {
      await requestGenericBackfillAsks({
        store: this.state,
        slack: this.slack,
        batch: this.config.slackBatchGenericBackfill,
        items: askItems.map((row) => ({
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          proof: `#${row.campaignId} ${row.campaignName} is ${row.shortBy} under the on-week 40. Tap Allow generics for exclusive client-signed fill (D205).`,
        })),
      });
    }

    if (!dryRun) await this.state.save();
    console.log(
      `[min40-topup] assigned=${result.assigned.length} asked=${result.asked.length} unfilled=${result.unfilled.length} errors=${result.errors.length}`,
    );
    return result;
  }

  private namedOnWeekEmails(
    accounts: SmartleadAccountWithCampaigns[],
    campaigns: SmartleadCampaign[],
    clients: SmartleadClientRecord[],
    onWeek: "A" | "B",
  ): Map<number, Set<string>> {
    const byClient = new Map<number, Array<{ email: string; type?: string | null }>>();
    const campaignClient = new Map(campaigns.map((c) => [c.id, c.client_id]));
    for (const account of accounts) {
      const email = accountEmail(account);
      if (!email) continue;
      if (isGenericMailbox(account, email, this.config, this.state)) continue;
      const clientId =
        typeof account.client_id === "number"
          ? account.client_id
          : campaignIdsOf(account)
              .map((id) => campaignClient.get(id))
              .find((id): id is number => typeof id === "number");
      if (typeof clientId !== "number") continue;
      const list = byClient.get(clientId) ?? [];
      list.push({ email, type: account.type });
      byClient.set(clientId, list);
    }
    const out = new Map<number, Set<string>>();
    for (const [clientId, rows] of byClient) {
      const cohorts = assignClientCohorts(rows);
      const set = new Set<string>();
      for (const [email, cohort] of cohorts) {
        if (cohort === onWeek) set.add(email);
      }
      out.set(clientId, set);
    }
    void clients;
    return out;
  }

  private countOnWeekStaffable(
    campaignId: number,
    clientId: number,
    accounts: SmartleadAccountWithCampaigns[],
    namedOnWeek: Set<string>,
  ): number {
    let n = 0;
    for (const account of accounts) {
      if (!campaignIdsOf(account).includes(campaignId)) continue;
      const email = accountEmail(account);
      if (!email) continue;
      if (
        !accountIsPeelStaffable(account, email, {
          getRestingInbox: (key) => this.state.getRestingInbox(key),
          isCopyCanary: (key) => this.state.isCopyCanary(key),
        })
      ) {
        continue;
      }
      const generic = isGenericMailbox(account, email, this.config, this.state);
      if (generic) {
        n += 1;
        continue;
      }
      if (namedOnWeek.has(email.toLowerCase())) n += 1;
    }
    void clientId;
    return n;
  }

  private async fillCampaign(input: {
    campaign: SmartleadCampaign;
    clientId: number;
    clientName: string;
    shortBy: number;
    dryRun: boolean;
    accounts: SmartleadAccountWithCampaigns[];
    campaignById: Map<number, SmartleadCampaign>;
    accountById: Map<number, SmartleadAccountWithCampaigns>;
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>;
    brandByClientId: Map<number, string>;
    result: Min40TopUpResult;
  }): Promise<number> {
    const brand =
      input.brandByClientId.get(input.clientId) ||
      input.clientName.replace(/\s*\(.*?\)\s*$/, "").trim() ||
      input.clientName;
    const espCounts = { GOOGLE: 0, MICROSOFT: 0 };
    for (const account of input.accounts) {
      if (!campaignIdsOf(account).includes(input.campaign.id)) continue;
      const platform = poolEspFromSmartleadType(account.type);
      if (platform) espCounts[platform] += 1;
    }
    const selected = new Set<string>();
    let placed = 0;
    for (let attempt = 0; placed < input.shortBy && attempt < input.shortBy * 2; attempt += 1) {
      const platformOrder = espFillOrder(
        espCounts,
        ON_WEEK_MIN_SENDERS,
        Math.round(POD_ESP_MIX_MIN_FRACTION * 100),
      );
      const pool = this.state.findReassignablePoolMailbox(platformOrder, (email) => {
        const key = email.toLowerCase();
        const domain = key.split("@")[1];
        const poolAccount = input.accountByEmail.get(key);
        if (selected.has(key)) return false;
        if (!poolAccount) return false;
        if (campaignIdsOf(poolAccount).includes(input.campaign.id)) {
          return false;
        }
        if (owesWarmup(poolAccount, key, this.config, this.state)) return false;
        if (this.state.getRestingInbox(key) || this.state.isCopyCanary(key)) return false;
        if (
          isRetiredSendingDomain(domain, this.state.getDomainHistory(domain))
        ) {
          return false;
        }
        if (
          senderIsAttachBlocked(
            { email: key, accountId: poolAccount.id, domain },
            this.state,
          )
        ) {
          return false;
        }
        if (!canAttachMailboxToCampaign(poolAccount, input.campaign, input.campaignById)) {
          return false;
        }
        if (!isPoolGenericSeat(poolAccount, key, this.config, this.state)) {
          return false;
        }
        const on = campaignIdsOf(poolAccount);
        for (const id of on) {
          const other = input.campaignById.get(id);
          if (!other || isAnyShellCampaign(other)) continue;
          if (other.client_id !== input.clientId && campaignIsActive(other)) {
            return false;
          }
        }
        return true;
      });
      if (!pool?.smartleadAccountId) break;
      const original = input.accountByEmail.get(pool.email.toLowerCase());
      if (!original) break;
      const firstName = pool.firstName || "Pool";
      const lastName = pool.lastName || "User";
      try {
        if (!input.dryRun) {
          await this.smartlead.addEmailAccountsToCampaign(input.campaign.id, [
            pool.smartleadAccountId,
          ]);
          recordMembership(original, input.campaign.id);
          await sleep(WRITE_GAP_MS);
          const insightTarget = isInsightCampaignId(input.campaign.id);
          await this.smartlead.updateEmailAccount(pool.smartleadAccountId, {
            signature: insightTarget
              ? INSIGHT_MAILBOX_SIGNATURE_BLANK
              : buildPoolSignature({ firstName, lastName, clientBrand: brand }),
            from_name: `${firstName} ${lastName}`,
            client_id: input.clientId,
            time_to_wait_in_mins: this.config.mailboxMinTimeGapMins,
            max_email_per_day: mailboxMessagePerDayTarget(
              { platform: pool.platform },
              this.config,
              {
                tenantZeroActive: this.state.isTenantZeroActive(
                  pool.smartleadAccountId ?? 0,
                ),
              },
            ),
          });
          this.state.upsertPoolMailbox({
            ...pool,
            status: "assigned",
            assignedClientId: input.clientId,
            assignedClientName: input.clientName,
            assignedAt: new Date().toISOString(),
          });
        }
        selected.add(pool.email.toLowerCase());
        if (pool.platform === "GOOGLE" || pool.platform === "MICROSOFT") {
          espCounts[pool.platform] += 1;
        }
        placed += 1;
        input.result.assigned.push({
          campaignId: input.campaign.id,
          campaignName: String(input.campaign.name ?? input.campaign.id),
          email: pool.email,
          clientId: input.clientId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.result.errors.push(`${pool.email} → #${input.campaign.id}: ${message}`);
        if (!input.dryRun) {
          try {
            await this.smartlead.removeEmailAccountsFromCampaign(input.campaign.id, [
              pool.smartleadAccountId,
            ]);
            dropMembership(original, input.campaign.id);
          } catch {
            // best-effort rollback
          }
        }
        break;
      }
    }
    void pocClientId;
    return placed;
  }
}
