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
import { clientAutoAllowsGenerics } from "../lib/autoAllowGenerics.js";
import {
  GENERIC_ASSIGN_REASON_POD_TOP_UP,
  clientPodKey,
  seatStaffableWeight,
} from "../lib/genericPool.js";
import { mailboxStaffableWeight, roundStaffableWeight } from "../lib/mailboxType.js";
import { syncGenericSeatsFromInventory } from "../lib/genericPoolCanon.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { isGenericMailbox, isPoolGenericSeat } from "../lib/clientInbox.js";
import {
  ON_WEEK_MIN_SENDERS,
  POD_ESP_MIX_MIN_FRACTION,
  accountIsPeelStaffable,
  hasHoldOrRetireTag,
} from "../lib/clientStaffFloor.js";
import { chicagoWallClock } from "../lib/canonOpsHours.js";
import { resolveDedicatedGenericClientId } from "../lib/dedicatedGeneric.js";
import {
  campaignHoldReason,
  holdPolicyFromConfig,
} from "../lib/holdPolicy.js";
import { requestGenericBackfillAsks } from "../lib/genericBackfillBatch.js";
import { senderIsAttachBlocked } from "../lib/attachBlock.js";
import { isRetiredSendingDomain } from "../lib/domainControl.js";
import { canAttachMailboxToCampaign } from "../lib/insightCampaigns.js";
import { isPocClient } from "../lib/pocClient.js";
import {
  buildPoolSignature,
  poolEspFromSmartleadType,
} from "../lib/poolSignature.js";
import {
  genericEligibleForClientPod,
  genericPodTagColor,
  genericPodTagName,
  lockedGenericPod,
  stampMailboxPodTag,
} from "../lib/genericAssign.js";
import { genericMayLinkToCampaigns, mailboxPodOf, podInventoryNeed } from "../lib/podInventory.js";
import { assignClientCohorts, onWeekCohort } from "../lib/restCohort.js";
import { mailboxMessagePerDayTarget } from "../lib/sendCeiling.js";
import { accountOnBounceHold } from "../lib/bounceHold.js";
import { sleep } from "../lib/http.js";
import {
  INSIGHT_MAILBOX_SIGNATURE_BLANK,
  isInsightCampaignId,
} from "../lib/insightCampaigns.js";
import type { StateStore } from "../state/store.js";
import { activeHoldUntilDate, owesWarmup, tagNames } from "./warmupGate.js";
import { espFillOrder, isExcluded } from "./campaignTopUp.js";
import {
  dropMembership,
  fetchInventory,
  recordMembership,
  type InventorySnapshot,
} from "./inventory.js";
import { isPowerGrydClientId } from "./powerGrydWatch.js";
import { returnSurplusGenerics } from "./genericSurplusReturn.js";

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
  returned: Array<{ email: string; clientId: number }>;
  errors: string[];
  alerts: string[];
}

function campaignIsActive(campaign: { status?: string | null } | undefined): boolean {
  const status = String(campaign?.status ?? "").toUpperCase();
  return status === "ACTIVE" || status === "START";
}

/**
 * D207 — every ACTIVE named-client campaign (including PowerGRYD) is
 * topped to 40 staffable senders from its own client. Already-linked
 * on-week named seats and that client's on-week generics are shared
 * first; free-pool generics get the client's id + signature and then
 * sit on every ACTIVE campaign of that same client. Off-week POD
 * generics stay assigned (client_id, POD tag, signature) and do not
 * link. Never retag named seats. Never retag a generic across PODs
 * (D230) — first assign of an untagged pool seat stamps that POD.
 * Never START/PAUSE. PowerGRYD uses its own seats; free-pool only via
 * the normal assign path (client 592842 + PG signature).
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
      returned: [],
      errors: [],
      alerts: [],
    };
    if (!this.config.enableMin40TopUp) {
      return { ...result, skipped: true, reason: "disabled" };
    }

    const { campaigns, accounts, clients } =
      opts.inventory ?? (await fetchInventory(this.smartlead));
    const now = opts.now ?? new Date();
    const seeded = syncGenericSeatsFromInventory({
      existing: this.state.listGenericSeats(),
      accounts,
      campaigns,
      config: this.config,
      state: this.state,
      now,
      powerGrydClientId: this.config.powerGrydClientId,
    });
    if (!dryRun) this.state.replaceGenericSeats(seeded.seats);
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
    const activeByClient = new Map<number, SmartleadCampaign[]>();
    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (!campaignIsActive(campaign)) continue;
      if (isAnyShellCampaign(campaign)) continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      if (typeof campaign.client_id !== "number") continue;
      const list = activeByClient.get(campaign.client_id) ?? [];
      list.push(campaign);
      activeByClient.set(campaign.client_id, list);
    }

    const askItems: Array<{ campaignId: number; campaignName: string; shortBy: number }> =
      [];
    const powerGrydShort: Array<{ campaignId: number; name: string; count: number; shortBy: number }> =
      [];

    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (!campaignIsActive(campaign)) continue;
      if (isAnyShellCampaign(campaign)) continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      if (campaignHoldReason(campaign, policy, todayYmd)) continue;
      const clientId = typeof campaign.client_id === "number" ? campaign.client_id : null;
      if (clientId == null) continue;
      const powerGryd = isPowerGrydClientId(clientId, this.config.powerGrydClientId);
      const clientName = clientDisplayName(
        clientsById.get(clientId) ?? { id: clientId },
      );
      if (
        !powerGryd &&
        isPocClient(`${campaign.name ?? ""} ${clientName}`, this.config.pocClientNamePatterns)
      ) {
        continue;
      }

      const staffable = this.countOnWeekStaffable(
        campaign.id,
        clientId,
        accounts as SmartleadAccountWithCampaigns[],
        namedOnWeek.get(clientId) ?? new Set(),
        campaignById,
        now,
      );
      const shortBy = roundStaffableWeight(Math.max(0, ON_WEEK_MIN_SENDERS - staffable));
      if (shortBy <= 0) continue;

      const auto =
        powerGryd ||
        clientAutoAllowsGenerics(clientId, this.config.autoAllowGenericClientIds);
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
        now,
        accounts: accounts as SmartleadAccountWithCampaigns[],
        campaignById,
        accountById,
        accountByEmail,
        brandByClientId,
        namedOnWeek: namedOnWeek.get(clientId) ?? new Set(),
        clientActive: activeByClient.get(clientId) ?? [],
        result,
      });
      const stillShort = Math.max(0, shortBy - placed);
      if (stillShort > 0) {
        result.unfilled.push({
          campaignId: campaign.id,
          name: String(campaign.name ?? campaign.id),
          shortBy: stillShort,
        });
        if (powerGryd) {
          powerGrydShort.push({
            campaignId: campaign.id,
            name: String(campaign.name ?? campaign.id),
            count: staffable + placed,
            shortBy: stillShort,
          });
        }
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
          proof: `#${row.campaignId} ${row.campaignName} is ${row.shortBy} under the per-campaign 40. Tap Allow generics for client-signed fill (D207).`,
        })),
      });
    }

    await this.fillShortPods({
      dryRun,
      now,
      accounts: accounts as SmartleadAccountWithCampaigns[],
      campaigns: campaigns as SmartleadCampaign[],
      campaignById,
      accountByEmail,
      brandByClientId,
      activeByClient,
      result,
    });

    await this.alertUnfilled(result, todayYmd, dryRun);
    await this.alertPowerGrydInventory(
      accounts as SmartleadAccountWithCampaigns[],
      namedOnWeek.get(this.config.powerGrydClientId) ?? new Set(),
      powerGrydShort,
      todayYmd,
      dryRun,
      result,
    );

    // D230 — morning named-warm swap + surplus beyond 40.
    const surplus = await returnSurplusGenerics({
      config: this.config,
      smartlead: this.smartlead,
      state: this.state,
      inventory: {
        campaigns,
        accounts,
        clients,
        fetchedAt: opts.inventory?.fetchedAt ?? 0,
      },
      dryRun,
      now,
    });
    result.returned.push(...surplus.returned);
    result.errors.push(...surplus.errors);

    if (!dryRun) await this.state.save();
    console.log(
      `[min40-topup] assigned=${result.assigned.length} asked=${result.asked.length} unfilled=${result.unfilled.length} returned=${result.returned.length} alerts=${result.alerts.length} errors=${result.errors.length}`,
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
    const taggedByEmail = new Map<string, "A" | "B">();
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
      const pod = mailboxPodOf(account);
      if (pod) taggedByEmail.set(email.toLowerCase(), pod);
    }
    const out = new Map<number, Set<string>>();
    for (const [clientId, rows] of byClient) {
      const untagged = rows.filter(
        (row) => !taggedByEmail.has(row.email.toLowerCase()),
      );
      const cohorts = assignClientCohorts(untagged);
      const set = new Set<string>();
      for (const row of rows) {
        const key = row.email.toLowerCase();
        const cohort = taggedByEmail.get(key) ?? cohorts.get(key);
        if (cohort === onWeek) set.add(key);
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
    campaignById: Map<number, SmartleadCampaign>,
    now: Date,
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
        if (!genericMayLinkToCampaigns(account, now)) continue;
        if (this.belongsToClient(account, email, clientId, campaignById)) {
          n = roundStaffableWeight(n + mailboxStaffableWeight(account));
        }
        continue;
      }
      if (namedOnWeek.has(email.toLowerCase())) {
        n = roundStaffableWeight(n + mailboxStaffableWeight(account));
      }
    }
    return n;
  }

  private seatIsUsable(
    account: SmartleadAccountWithCampaigns,
    email: string,
    campaign: SmartleadCampaign,
    campaignById: Map<number, SmartleadCampaign>,
  ): boolean {
    const key = email.toLowerCase();
    const domain = key.split("@")[1];
    if (owesWarmup(account, key, this.config, this.state)) return false;
    if (this.state.getRestingInbox(key) || this.state.isCopyCanary(key)) return false;
    if (activeHoldUntilDate(tagNames(account))) return false;
    if (hasHoldOrRetireTag(account)) return false;
    if (isRetiredSendingDomain(domain, this.state.getDomainHistory(domain))) {
      return false;
    }
    if (
      senderIsAttachBlocked(
        { email: key, accountId: account.id, domain },
        this.state,
      )
    ) {
      return false;
    }
    if (!canAttachMailboxToCampaign(account, campaign, campaignById)) {
      return false;
    }
    return true;
  }

  private belongsToClient(
    account: SmartleadAccountWithCampaigns,
    email: string,
    clientId: number,
    campaignById: Map<number, SmartleadCampaign>,
  ): boolean {
    if (account.client_id === clientId) return true;
    const pool = this.state.getPoolMailbox(email.toLowerCase());
    if (pool?.assignedClientId === clientId) return true;
    const dedicated = resolveDedicatedGenericClientId(
      account,
      email,
      campaignIdsOf(account).map((id) => {
        const campaign = campaignById.get(id);
        return {
          clientId: typeof campaign?.client_id === "number" ? campaign.client_id : null,
          shell: campaign ? isAnyShellCampaign(campaign) : false,
        };
      }),
      this.state,
      { brandByClientId: undefined },
    );
    return dedicated === clientId;
  }

  private genericMayTakePod(
    account: SmartleadAccountWithCampaigns,
    email: string,
    clientId: number,
    targetPod: "A" | "B",
  ): boolean {
    const seat = this.state.getGenericSeat(email);
    if (!seat) return false;
    const pool = this.state.getPoolMailbox(email);
    return genericEligibleForClientPod({
      clientId,
      targetPod,
      mailboxClientId: typeof account.client_id === "number" ? account.client_id : null,
      assignedClientId: seat.assignedClientId ?? pool?.assignedClientId ?? null,
      tags: account.tags,
      assignedPod: seat.assignedPod ?? null,
    });
  }

  private async stampGenericPod(
    account: SmartleadAccountWithCampaigns,
    email: string,
    clientId: number,
    pod: "A" | "B",
    dryRun: boolean,
  ): Promise<void> {
    if (lockedGenericPod({ tags: account.tags, assignedPod: this.state.getGenericSeat(email)?.assignedPod }) === pod) {
      return;
    }
    if (!dryRun && typeof account.id === "number" && this.smartlead.ensureTag && this.smartlead.assignTags) {
      const tag = await this.smartlead.ensureTag(genericPodTagName(pod), genericPodTagColor(pod));
      await this.smartlead.assignTags([account.id], [tag.id]);
      await sleep(WRITE_GAP_MS);
    }
    account.tags = stampMailboxPodTag(account.tags, pod);
    if (dryRun) return;
    if (!this.state.getGenericSeat(email)) {
      this.state.ensureGenericSeat({
        email,
        slAccountId: typeof account.id === "number" ? account.id : null,
      });
    }
    const assigned = this.state.assignGenericFromTable({
      email,
      clientId,
      pod,
      reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
      campaignIds: campaignIdsOf(account),
      slAccountId: typeof account.id === "number" ? account.id : null,
    });
    if (!assigned.ok) {
      console.warn(
        `[min40] refused generic table assign ${email}: ${assigned.error}`,
      );
    }
  }

  private async attachSeat(input: {
    account: SmartleadAccountWithCampaigns;
    email: string;
    campaign: SmartleadCampaign;
    clientId: number;
    dryRun: boolean;
    result: Min40TopUpResult;
  }): Promise<boolean> {
    if (typeof input.account.id !== "number") return false;
    try {
      if (!input.dryRun) {
        await this.smartlead.addEmailAccountsToCampaign(input.campaign.id, [
          input.account.id,
        ]);
        recordMembership(input.account, input.campaign.id);
        await sleep(WRITE_GAP_MS);
        if (isGenericMailbox(input.account, input.email, this.config, this.state)) {
          if (!this.state.getGenericSeat(input.email)) {
            this.state.ensureGenericSeat({
              email: input.email,
              slAccountId: input.account.id,
            });
          }
          const assigned = this.state.assignGenericFromTable({
            email: input.email,
            clientId: input.clientId,
            reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
            campaignIds: [input.campaign.id],
            slAccountId: input.account.id,
          });
          if (!assigned.ok) {
            console.warn(
              `[min40] refused generic table assign ${input.email}: ${assigned.error}`,
            );
          }
        }
      }
      input.result.assigned.push({
        campaignId: input.campaign.id,
        campaignName: String(input.campaign.name ?? input.campaign.id),
        email: input.email,
        clientId: input.clientId,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.result.errors.push(`${input.email} → #${input.campaign.id}: ${message}`);
      return false;
    }
  }

  private async fillCampaign(input: {
    campaign: SmartleadCampaign;
    clientId: number;
    clientName: string;
    shortBy: number;
    dryRun: boolean;
    now: Date;
    accounts: SmartleadAccountWithCampaigns[];
    campaignById: Map<number, SmartleadCampaign>;
    accountById: Map<number, SmartleadAccountWithCampaigns>;
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>;
    brandByClientId: Map<number, string>;
    namedOnWeek: Set<string>;
    clientActive: SmartleadCampaign[];
    result: Min40TopUpResult;
  }): Promise<number> {
    const brand =
      input.brandByClientId.get(input.clientId) ||
      input.clientName.replace(/\s*\(.*?\)\s*$/, "").trim() ||
      input.clientName;
    const selected = new Set<string>();
    let placed = 0;

    const existing = input.accounts.filter((account) => {
      const email = accountEmail(account);
      if (!email || selected.has(email.toLowerCase())) return false;
      if (campaignIdsOf(account).includes(input.campaign.id)) return false;
      if (
        !accountIsPeelStaffable(account, email, {
          getRestingInbox: (key) => this.state.getRestingInbox(key),
          isCopyCanary: (key) => this.state.isCopyCanary(key),
        })
      ) {
        return false;
      }
      if (!this.seatIsUsable(account, email, input.campaign, input.campaignById)) {
        return false;
      }
      const generic = isGenericMailbox(account, email, this.config, this.state);
      if (generic) {
        if (!genericMayLinkToCampaigns(account, input.now)) return false;
        if (!this.belongsToClient(account, email, input.clientId, input.campaignById)) {
          return false;
        }
        return this.genericMayTakePod(account, email, input.clientId, onWeekCohort(input.now));
      }
      return input.namedOnWeek.has(email.toLowerCase());
    });
    existing.sort((a, b) => {
      const aGeneric = isGenericMailbox(
        a,
        accountEmail(a) ?? "",
        this.config,
        this.state,
      );
      const bGeneric = isGenericMailbox(
        b,
        accountEmail(b) ?? "",
        this.config,
        this.state,
      );
      if (aGeneric !== bGeneric) return aGeneric ? 1 : -1;
      return (accountEmail(a) ?? "").localeCompare(accountEmail(b) ?? "");
    });

    for (const account of existing) {
      if (placed >= input.shortBy - 1e-9) break;
      const email = accountEmail(account);
      if (!email) continue;
      const ok = await this.attachSeat({
        account,
        email,
        campaign: input.campaign,
        clientId: input.clientId,
        dryRun: input.dryRun,
        result: input.result,
      });
      if (ok) {
        selected.add(email.toLowerCase());
        placed = roundStaffableWeight(placed + mailboxStaffableWeight(account));
      }
    }

    const espCounts = { GOOGLE: 0, MICROSOFT: 0 };
    for (const account of input.accounts) {
      if (!campaignIdsOf(account).includes(input.campaign.id)) continue;
      const platform = poolEspFromSmartleadType(account.type);
      if (platform) espCounts[platform] += 1;
    }

    while (placed < input.shortBy - 1e-9) {
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
        if (!this.seatIsUsable(poolAccount, key, input.campaign, input.campaignById)) {
          return false;
        }
        if (!genericMayLinkToCampaigns(poolAccount, input.now)) return false;
        if (!isPoolGenericSeat(poolAccount, key, this.config, this.state)) {
          return false;
        }
        if (!this.state.getGenericSeat(key)) return false;
        if (!this.genericMayTakePod(poolAccount, key, input.clientId, onWeekCohort(input.now))) {
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
        void domain;
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
            ...(accountOnBounceHold(
              { id: pool.smartleadAccountId, platform: pool.platform },
              this.state,
            )
              ? {}
              : {
                  max_email_per_day: mailboxMessagePerDayTarget(
                    {
                      id: pool.smartleadAccountId,
                      platform: pool.platform,
                      email: pool.email,
                    },
                    this.config,
                    this.state,
                  ),
                }),
          });
          this.state.upsertPoolMailbox({
            ...pool,
            status: "assigned",
            assignedClientId: input.clientId,
            assignedClientName: input.clientName,
            assignedAt: new Date().toISOString(),
          });
          await this.stampGenericPod(
            original,
            pool.email,
            input.clientId,
            onWeekCohort(input.now),
            input.dryRun,
          );
          for (const sibling of input.clientActive) {
            if (sibling.id === input.campaign.id) continue;
            if (campaignIdsOf(original).includes(sibling.id)) continue;
            if (!this.seatIsUsable(original, pool.email, sibling, input.campaignById)) {
              continue;
            }
            try {
              await this.smartlead.addEmailAccountsToCampaign(sibling.id, [
                pool.smartleadAccountId,
              ]);
              recordMembership(original, sibling.id);
              await sleep(WRITE_GAP_MS);
            } catch (shareError) {
              const message =
                shareError instanceof Error ? shareError.message : String(shareError);
              input.result.errors.push(
                `${pool.email} share → #${sibling.id}: ${message}`,
              );
            }
          }
        }
        selected.add(pool.email.toLowerCase());
        if (pool.platform === "GOOGLE" || pool.platform === "MICROSOFT") {
          espCounts[pool.platform] += 1;
        }
        placed = roundStaffableWeight(
          placed + mailboxStaffableWeight(original ?? pool),
        );
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
            // Failed-assign rollback — this seat never successfully staffed.
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
    return placed;
  }

  private async fillShortPods(input: {
    dryRun: boolean;
    now: Date;
    accounts: SmartleadAccountWithCampaigns[];
    campaigns: SmartleadCampaign[];
    campaignById: Map<number, SmartleadCampaign>;
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>;
    brandByClientId: Map<number, string>;
    activeByClient: Map<number, SmartleadCampaign[]>;
    result: Min40TopUpResult;
  }): Promise<void> {
    const synced = syncGenericSeatsFromInventory({
      existing: this.state.listGenericSeats(),
      accounts: input.accounts,
      campaigns: input.campaigns,
      config: this.config,
      state: this.state,
      now: input.now,
      powerGrydClientId: this.config.powerGrydClientId,
    });
    if (!input.dryRun) {
      this.state.replaceGenericSeats(synced.seats);
    }
    const onWeek = onWeekCohort(input.now);
    for (const [clientId, clientActive] of input.activeByClient) {
      const powerGryd = isPowerGrydClientId(clientId, this.config.powerGrydClientId);
      if (
        !powerGryd &&
        !clientAutoAllowsGenerics(clientId, this.config.autoAllowGenericClientIds)
      ) {
        continue;
      }
      const brand = input.brandByClientId.get(clientId) || String(clientId);
      const selected = new Set<string>();
      for (const pod of ["A", "B"] as const) {
        const named = synced.namedStaffableByClientPod.get(clientPodKey(clientId, pod)) ?? 0;
        const assigned = synced.seats
          .filter((seat) => seat.assignedClientId === clientId && seat.assignedPod === pod)
          .reduce((sum, seat) => sum + seatStaffableWeight(seat), 0);
        let need = podInventoryNeed(named, assigned);
        while (need > 1e-9) {
          const pool = this.state.findReassignablePoolMailbox(
            ["GOOGLE", "MICROSOFT"],
            (email) => {
              const key = email.toLowerCase();
              if (selected.has(key)) return false;
              const account = input.accountByEmail.get(key);
              if (!account) return false;
              if (!isPoolGenericSeat(account, email, this.config, this.state)) {
                return false;
              }
              if (!this.state.getGenericSeat(key)) return false;
              const owner =
                typeof account.client_id === "number" ? account.client_id : null;
              if (owner != null && owner !== clientId) return false;
              if (lockedGenericPod({ tags: account.tags }) === pod) return false;
              if (!this.seatIsUsable(account, email, clientActive[0]!, input.campaignById)) {
                return false;
              }
              return this.genericMayTakePod(account, email, clientId, pod);
            },
          );
          if (!pool?.smartleadAccountId) break;
          const original = input.accountByEmail.get(pool.email.toLowerCase());
          if (!original) break;
          const firstName = pool.firstName || "Pool";
          const lastName = pool.lastName || "User";
          try {
            if (!input.dryRun) {
              await this.smartlead.updateEmailAccount(pool.smartleadAccountId, {
                signature: buildPoolSignature({
                  firstName,
                  lastName,
                  clientBrand: brand,
                }),
                from_name: `${firstName} ${lastName}`,
                client_id: clientId,
                time_to_wait_in_mins: this.config.mailboxMinTimeGapMins,
              });
              original.client_id = clientId;
              this.state.upsertPoolMailbox({
                ...pool,
                status: "assigned",
                assignedClientId: clientId,
                assignedAt: new Date().toISOString(),
              });
              await this.stampGenericPod(original, pool.email, clientId, pod, input.dryRun);
              if (pod === onWeek) {
                for (const campaign of clientActive) {
                  if (campaignIdsOf(original).includes(campaign.id)) continue;
                  if (!this.seatIsUsable(original, pool.email, campaign, input.campaignById)) {
                    continue;
                  }
                  await this.smartlead.addEmailAccountsToCampaign(campaign.id, [
                    pool.smartleadAccountId,
                  ]);
                  recordMembership(original, campaign.id);
                  await sleep(WRITE_GAP_MS);
                }
              }
            }
            selected.add(pool.email.toLowerCase());
            input.result.assigned.push({
              campaignId: clientActive[0]?.id ?? 0,
              campaignName: String(clientActive[0]?.name ?? clientId),
              email: pool.email,
              clientId,
            });
            need = roundStaffableWeight(need - mailboxStaffableWeight(original));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            input.result.errors.push(`${pool.email} POD ${pod}: ${message}`);
            break;
          }
        }
      }
    }
  }

  private async alertUnfilled(
    result: Min40TopUpResult,
    todayYmd: string,
    dryRun: boolean,
  ): Promise<void> {
    if (!this.slack) return;
    for (const row of result.unfilled) {
      const key = `campaign:${row.campaignId}`;
      if (this.state.getMin40ShortfallAlerted(key) === todayYmd) continue;
      const count = ON_WEEK_MIN_SENDERS - row.shortBy;
      const line = `ACTIVE #${row.campaignId} ${row.name} is at ${count}/40 staffable (short ${row.shortBy}). Pool/client inventory did not fill the per-campaign floor (D207).`;
      console.warn(`[min40-topup] ${line}`);
      result.alerts.push(line);
      if (!dryRun) {
        await this.slack.send(line, undefined, "ops_alert");
        this.state.setMin40ShortfallAlerted(key, todayYmd);
      }
    }
  }

  private async alertPowerGrydInventory(
    accounts: SmartleadAccountWithCampaigns[],
    namedOnWeek: Set<string>,
    shortCampaigns: Array<{ campaignId: number; name: string; count: number; shortBy: number }>,
    todayYmd: string,
    dryRun: boolean,
    result: Min40TopUpResult,
  ): Promise<void> {
    if (!shortCampaigns.length || !this.slack) return;
    const clientId = this.config.powerGrydClientId;
    const emails = new Set<string>();
    for (const account of accounts) {
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
        if (account.client_id === clientId) emails.add(email.toLowerCase());
        continue;
      }
      if (account.client_id === clientId || namedOnWeek.has(email.toLowerCase())) {
        emails.add(email.toLowerCase());
      }
    }
    const total = emails.size;
    if (total >= ON_WEEK_MIN_SENDERS) return;
    const key = "powergryd-inventory";
    if (this.state.getMin40ShortfallAlerted(key) === todayYmd) return;
    const names = shortCampaigns.map((row) => `#${row.campaignId} ${row.name}`).join(", ");
    const line = `PowerGRYD has ${total} staffable seats (short ${ON_WEEK_MIN_SENDERS - total} of 40). Linked all of them across ${shortCampaigns.length} ACTIVE campaign(s) (${names}). Did not START or PAUSE anyone (D207).`;
    console.warn(`[min40-topup] ${line}`);
    result.alerts.push(line);
    if (!dryRun) {
      await this.slack.send(line, undefined, "ops_alert");
      this.state.setMin40ShortfallAlerted(key, todayYmd);
    }
  }
}
