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
  GENERIC_ASSIGN_REASON_POD_TOP_UP,
  GENERIC_ASSIGN_REASON_POC_ENGAGEMENT,
  clientPodKey,
  seatStaffableWeight,
} from "../lib/genericPool.js";
import { displayShortfallSenders } from "../lib/displaySenderCount.js";
import {
  classifyMailboxSendType,
  mailboxEspSlot,
  mailboxStaffableWeight,
  roundStaffableWeight,
} from "../lib/mailboxType.js";
import {
  syncGenericSeatsFromInventory,
  type GenericPoolSyncResult,
} from "../lib/genericPoolCanon.js";
import {
  gabeVmReservedCampaignIds,
  isGabeVmReserved,
  isLockedCanarySeat,
} from "../lib/canaryLock.js";
import {
  callerFollowUpMayAttach,
  callerFollowUpPolicyFromConfig,
  isCallerFollowUpCampaign,
  isCallerFollowUpSupplyBlocked,
} from "../lib/callerFollowUp.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { isGenericMailbox, isPoolGenericSeat } from "../lib/clientInbox.js";
import {
  ON_WEEK_MIN_SENDERS,
  POD_ESP_MIX_MIN_FRACTION,
  accountIsPeelStaffable,
  hasHoldOrRetireTag,
} from "../lib/clientStaffFloor.js";
import { minFloorForClient } from "../lib/minFloorByClient.js";
import { chicagoWallClock } from "../lib/canonOpsHours.js";
import {
  isRealNamedClientId,
  preferredGenericOwnerId,
  resolveDedicatedGenericClientId,
} from "../lib/dedicatedGeneric.js";
import {
  brandsFromClients,
  genericBlockedOnPowerGrydStaffing,
  isPowerGrydEmptyByDesign,
  powerGrydBrandFromClients,
} from "../lib/powerGrydEmptyByDesign.js";
import { isPowerGrydClientId } from "../lib/namedClientIds.js";
import {
  campaignHoldReason,
  holdPolicyFromConfig,
} from "../lib/holdPolicy.js";
import { senderIsAttachBlocked } from "../lib/attachBlock.js";
import { isRetiredSendingDomain } from "../lib/domainControl.js";
import { canAttachMailboxToCampaign } from "../lib/insightCampaigns.js";
import { hasPocReservationTag, POC_TAG } from "../lib/markerClients.js";
import {
  isPocEngagementClient,
  pocEngagementClientIds,
  pocEngagementSeatTarget,
  pocSignature,
  shouldStaffPocCampaign,
} from "../lib/pocClient.js";
import { buildPoolSignature } from "../lib/poolSignature.js";
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
import { dropGhostPoolSeats } from "../lib/poolInventoryReconcile.js";
import { findReassignablePoolMailboxYielding } from "../lib/poolPick.js";
import { yieldEventLoop } from "../lib/stringifyYielding.js";
import type { PoolMailboxRecord } from "../state/store.js";
import {
  groupShortStaffedByClient,
  shortStaffedLines,
  shortStaffedSnapshot,
} from "../lib/shortStaffedSlack.js";
import {
  INSIGHT_MAILBOX_SIGNATURE_BLANK,
  insightExemptFromSenderTopUp,
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
import { returnSurplusGenerics } from "./genericSurplusReturn.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 250;

/** D250 — yield so a 366-campaign × 1000-seat count cannot pin the loop. */
export const MIN40_YIELD_EVERY = 4;
/** D252 — yield inside a fill / candidate / pool scan. */
export const MIN40_SEAT_YIELD_EVERY = 8;

interface IndexedSeat {
  account: SmartleadAccountWithCampaigns;
  email: string;
  generic: boolean;
  peelStaffable: boolean;
  weight: number;
  campaignIds: Set<number>;
}

interface SeatIndex {
  seats: IndexedSeat[];
  byCampaign: Map<number, IndexedSeat[]>;
}

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
  unfilled: Array<{
    campaignId: number;
    name: string;
    shortBy: number;
    floor?: number;
    clientId?: number;
    clientName?: string;
  }>;
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
 * Never START/PAUSE. D256 — fill to that client's min-floor
 * (`MIN_FLOOR_BY_CLIENT`, default 40; TechEvo 30) and return
 * surplus generics above it. PowerGRYD is a normal named
 * client (not POC, not a no-generics special-case).
 * D254 — POC fills use the same one-client / on-week-POD lock:
 * refuse another client's seat and any seat whose locked POD is not
 * the on-week POD. Check the POD before linking, not after. Canary
 * and client-named-domain seats are never generics. The named A/B
 * split stays static. The summary includes each named client's
 * on-week POD shortfall (PowerGRYD included) and pages when that
 * POD has zero generics.
 * D268 — no Allow-generics Slack card and no auto-allow list. Every
 * named client gets the same thin floor-only top-up of the on-week
 * POD. Never add generics past the floor. Never add them when named
 * seats already cover that POD. Never assign new generics to the
 * off-week cylinder.
 */
export class Min40TopUpService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  /** D258 — PowerGRYD branded-warming empty-by-design for this pass. */
  private powerGrydEmptyByDesign = false;
  private powerGrydBrand = "PowerGRYD";
  private allClientBrands: string[] = [];

  async run(
    opts: {
      dryRun?: boolean;
      inventory?: InventorySnapshot;
      now?: Date;
      signal?: AbortSignal;
    } = {},
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
    console.log(
      `[min40-topup] start campaigns=${campaigns.length} accounts=${accounts.length}`,
    );
    const endedIds = this.state.listEndedPocClientIds();
    const pocIds = pocEngagementClientIds(
      clients,
      this.config.pocClientNamePatterns,
      endedIds,
    );
    const seeded = await syncGenericSeatsFromInventory({
      existing: this.state.listGenericSeats(),
      accounts,
      campaigns,
      config: this.config,
      state: this.state,
      now,
      powerGrydClientId: this.config.powerGrydClientId,
      pocEngagementClientIds: pocIds,
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
    const ghosts = dropGhostPoolSeats(this.state, accountByEmail);
    if (ghosts.length) {
      console.warn(
        `[min40-topup] dropped ${ghosts.length} ghost pool seat(s) missing from Smartlead inventory`,
      );
      if (!dryRun) {
        await this.state.persistPoolPrune();
      }
    }
    const poolMailboxes = this.state.listPoolMailboxes();
    const brandByClientId = new Map<number, string>();
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }
    this.powerGrydEmptyByDesign = isPowerGrydEmptyByDesign({
      accounts: accounts as SmartleadAccountWithCampaigns[],
      config: this.config,
      state: this.state,
      clientId: this.config.powerGrydClientId,
    });
    this.powerGrydBrand = powerGrydBrandFromClients(
      clients,
      this.config.powerGrydClientId,
    );
    this.allClientBrands = brandsFromClients(clients);
    if (this.powerGrydEmptyByDesign) {
      console.log(
        `[min40-topup] PowerGRYD empty-by-design (branded seats still warming) — refuse foreign-signature / foreign-client generics`,
      );
    }
    const seatIndex = await this.indexSeats(
      accounts as SmartleadAccountWithCampaigns[],
      opts.signal,
    );
    const namedOnWeek = this.namedOnWeekEmails(
      seatIndex.seats,
      campaigns as SmartleadCampaign[],
      clients,
      onWeek,
    );
    const seatsByClient = await this.indexSeatsByClient(
      seatIndex.seats,
      campaignById,
      opts.signal,
    );
    const livingByClient = new Map<number, SmartleadCampaign[]>();
    const reservedCampaignIds = gabeVmReservedCampaignIds(
      accounts as SmartleadAccountWithCampaigns[],
    );
    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (isAnyShellCampaign(campaign)) continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      if (
        isCallerFollowUpCampaign(
          campaign,
          callerFollowUpPolicyFromConfig(this.config),
        )
      ) {
        continue;
      }
      if (insightExemptFromSenderTopUp(campaign)) continue;
      if (typeof campaign.client_id !== "number") continue;
      const poc = pocIds.includes(campaign.client_id);
      if (poc) {
        if (!shouldStaffPocCampaign(campaign, { reservedCampaignIds })) continue;
      } else if (!campaignIsActive(campaign)) {
        continue;
      }
      const list = livingByClient.get(campaign.client_id) ?? [];
      list.push(campaign);
      livingByClient.set(campaign.client_id, list);
    }
    const activeByClient = livingByClient;

    let walked = 0;

    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (isAnyShellCampaign(campaign)) continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      if (
        isCallerFollowUpCampaign(
          campaign,
          callerFollowUpPolicyFromConfig(this.config),
        )
      ) {
        continue;
      }
      if (insightExemptFromSenderTopUp(campaign)) continue;
      if (campaignHoldReason(campaign, policy, todayYmd)) continue;
      const clientId = typeof campaign.client_id === "number" ? campaign.client_id : null;
      if (clientId == null) continue;
      const client = clientsById.get(clientId);
      const clientName = clientDisplayName(client ?? { id: clientId });
      const pocEngagement = isPocEngagementClient({
        clientId,
        hay: clientName,
        name: client?.name,
        logo: client?.logo,
        patterns: this.config.pocClientNamePatterns,
        endedIds,
      });
      if (pocEngagement) {
        if (!shouldStaffPocCampaign(campaign, { reservedCampaignIds })) continue;
      } else if (!campaignIsActive(campaign)) {
        continue;
      }

      const floor = minFloorForClient(clientId, this.config.minFloorByClient);
      const target = pocEngagement ? pocEngagementSeatTarget() : floor;
      walked += 1;
      if (opts.signal?.aborted) {
        result.errors.push("aborted: stopped remaining campaign fills");
        break;
      }
      if (walked % MIN40_YIELD_EVERY === 0) await yieldEventLoop();
      const staffable = this.countOnWeekStaffable(
        clientId,
        seatIndex.byCampaign.get(campaign.id) ?? [],
        namedOnWeek.get(clientId) ?? new Set(),
        campaignById,
        now,
        { ignorePodWeek: pocEngagement },
      );
      const shortBy = roundStaffableWeight(Math.max(0, target - staffable));
      if (shortBy <= 0) continue;

      const placed = await this.fillCampaign({
        campaign,
        clientId,
        clientName,
        shortBy,
        dryRun,
        now,
        seats: seatsByClient.get(clientId) ?? [],
        members: seatIndex.byCampaign.get(campaign.id) ?? [],
        campaignById,
        accountById,
        accountByEmail,
        brandByClientId,
        namedOnWeek: namedOnWeek.get(clientId) ?? new Set(),
        clientActive: livingByClient.get(clientId) ?? [],
        result,
        pocEngagement,
        target,
        signal: opts.signal,
        poolMailboxes,
      });
      const stillShort = Math.max(0, shortBy - placed);
      if (stillShort > 0) {
        result.unfilled.push({
          campaignId: campaign.id,
          name: String(campaign.name ?? campaign.id),
          shortBy: stillShort,
          floor: target,
          clientId,
          clientName,
        });
      }
    }

    if (!opts.signal?.aborted) {
      await this.fillShortPods({
        dryRun,
        now,
        accounts: accounts as SmartleadAccountWithCampaigns[],
        seats: seatIndex.seats,
        campaigns: campaigns as SmartleadCampaign[],
        campaignById,
        accountByEmail,
        brandByClientId,
        activeByClient,
        result,
        pocIds,
        signal: opts.signal,
        poolMailboxes,
        synced: seeded,
      });
    }

    this.reportOnWeekPodShortfalls({
      now,
      namedStaffableByClientPod: seeded.namedStaffableByClientPod,
      activeByClient,
      clientsById,
      pocIds,
      result,
    });

    await this.alertUnfilled(result, todayYmd, dryRun);

    // D230 — morning named-warm swap + surplus beyond 40.
    // D252 — post-walk Slack / surplus / save failures must not hide a
    // finished fill (lastOk stays stale) and must not keep placing.
    try {
      if (!opts.signal?.aborted) {
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
          signal: opts.signal,
        });
        result.returned.push(...surplus.returned);
        result.errors.push(...surplus.errors);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`surplus: ${message}`);
    }

    try {
      if (!dryRun) await this.state.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`save: ${message}`);
    }
    console.log(
      `[min40-topup] assigned=${result.assigned.length} asked=${result.asked.length} unfilled=${result.unfilled.length} returned=${result.returned.length} alerts=${result.alerts.length} errors=${result.errors.length}`,
    );
    return result;
  }

  private async indexSeats(
    accounts: SmartleadAccountWithCampaigns[],
    signal?: AbortSignal,
  ): Promise<SeatIndex> {
    const seats: IndexedSeat[] = [];
    const byCampaign = new Map<number, IndexedSeat[]>();
    let n = 0;
    for (const account of accounts) {
      if (signal?.aborted) break;
      const email = accountEmail(account);
      if (!email) continue;
      const key = email.toLowerCase();
      const ids = campaignIdsOf(account);
      const seat: IndexedSeat = {
        account,
        email: key,
        generic: isGenericMailbox(account, email, this.config, this.state),
        peelStaffable: accountIsPeelStaffable(account, email, {
          getRestingInbox: (restKey) => this.state.getRestingInbox(restKey),
          isCopyCanary: (restKey) => this.state.isCopyCanary(restKey),
        }),
        weight: mailboxStaffableWeight(account),
        campaignIds: new Set(ids),
      };
      seats.push(seat);
      for (const id of ids) {
        const list = byCampaign.get(id) ?? [];
        list.push(seat);
        byCampaign.set(id, list);
      }
      n += 1;
      if (n % 64 === 0) await yieldEventLoop();
    }
    return { seats, byCampaign };
  }

  /**
   * D252 — fill walks this client's seats, not the whole 1300-seat book.
   * Dedicated / assigned / tagged client ids are resolved once.
   */
  private async indexSeatsByClient(
    seats: IndexedSeat[],
    campaignById: Map<number, SmartleadCampaign>,
    signal?: AbortSignal,
  ): Promise<Map<number, IndexedSeat[]>> {
    const byClient = new Map<number, IndexedSeat[]>();
    let n = 0;
    for (const seat of seats) {
      if (signal?.aborted) break;
      const ids = new Set<number>();
      if (typeof seat.account.client_id === "number") {
        ids.add(seat.account.client_id);
      }
      const pool = this.state.getPoolMailbox(seat.email);
      const table = this.state.getGenericSeat(seat.email);
      const liveId =
        typeof seat.account.client_id === "number" ? seat.account.client_id : null;
      const addAssigned = (assigned: number | undefined | null): void => {
        if (typeof assigned !== "number") return;
        // D258 — do not index a stale pool assignment against a live
        // Smartlead named client that disagrees.
        if (
          liveId != null &&
          isRealNamedClientId(liveId) &&
          assigned !== liveId
        ) {
          return;
        }
        ids.add(assigned);
      };
      addAssigned(pool?.assignedClientId);
      addAssigned(table?.assignedClientId);
      if (seat.generic) {
        const dedicated = resolveDedicatedGenericClientId(
          seat.account,
          seat.email,
          [...seat.campaignIds].map((id) => {
            const campaign = campaignById.get(id);
            return {
              clientId: typeof campaign?.client_id === "number" ? campaign.client_id : null,
              shell: campaign ? isAnyShellCampaign(campaign) : false,
            };
          }),
          this.state,
          { brandByClientId: undefined },
        );
        if (typeof dedicated === "number") ids.add(dedicated);
      } else {
        for (const id of seat.campaignIds) {
          const campaign = campaignById.get(id);
          if (typeof campaign?.client_id === "number") ids.add(campaign.client_id);
        }
      }
      for (const id of ids) {
        const list = byClient.get(id);
        if (list) list.push(seat);
        else byClient.set(id, [seat]);
      }
      n += 1;
      if (n % 64 === 0) await yieldEventLoop();
    }
    return byClient;
  }

  private namedOnWeekEmails(
    seats: IndexedSeat[],
    campaigns: SmartleadCampaign[],
    clients: SmartleadClientRecord[],
    onWeek: "A" | "B",
  ): Map<number, Set<string>> {
    const byClient = new Map<number, Array<{ email: string; type?: string | null }>>();
    const taggedByEmail = new Map<string, "A" | "B">();
    const campaignClient = new Map(campaigns.map((c) => [c.id, c.client_id]));
    for (const seat of seats) {
      if (seat.generic) continue;
      const account = seat.account;
      const clientId =
        typeof account.client_id === "number"
          ? account.client_id
          : [...seat.campaignIds]
              .map((id) => campaignClient.get(id))
              .find((id): id is number => typeof id === "number");
      if (typeof clientId !== "number") continue;
      const list = byClient.get(clientId) ?? [];
      list.push({ email: seat.email, type: account.type });
      byClient.set(clientId, list);
      const pod = mailboxPodOf(account);
      if (pod) taggedByEmail.set(seat.email, pod);
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
    clientId: number,
    members: IndexedSeat[],
    namedOnWeek: Set<string>,
    campaignById: Map<number, SmartleadCampaign>,
    now: Date,
    opts: { ignorePodWeek?: boolean } = {},
  ): number {
    let n = 0;
    for (const seat of members) {
      if (!seat.peelStaffable) continue;
      if (seat.generic) {
        if (!opts.ignorePodWeek && !genericMayLinkToCampaigns(seat.account, now)) {
          continue;
        }
        if (this.belongsToClient(seat.account, seat.email, clientId, campaignById)) {
          n = roundStaffableWeight(n + seat.weight);
        }
        continue;
      }
      if (namedOnWeek.has(seat.email)) {
        n = roundStaffableWeight(n + seat.weight);
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
    if (this.state.getRestingInbox(key) || isLockedCanarySeat(account, key, this.state)) {
      return false;
    }
    if (isGabeVmReserved(account)) return false;
    // D245: never staff a seat whose InboxKit license is lapsed or ends
    // within 7 days (10/5 latoyaflatley: scheduled_for_cancellation 9/11).
    if (
      typeof this.state.isInboxKitEndingSoon === "function" &&
      this.state.isInboxKitEndingSoon(key)
    ) {
      return false;
    }
    const classPolicy = callerFollowUpPolicyFromConfig(this.config);
    if (isCallerFollowUpSupplyBlocked(account, email, classPolicy)) {
      return false;
    }
    // D264 — sibling share / POD fill must not land non-class seats on
    // Gabe Calls even if the campaign list is wrong.
    if (
      !callerFollowUpMayAttach({
        email,
        account,
        campaign,
        warmed: true,
        policy: classPolicy,
      }).ok
    ) {
      return false;
    }
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
    // D258 — live Smartlead named client_id wins over a stale pool row.
    if (
      typeof account.client_id === "number" &&
      isRealNamedClientId(account.client_id) &&
      account.client_id !== clientId
    ) {
      return false;
    }
    const pool = this.state.getPoolMailbox(email.toLowerCase());
    const seat = this.state.getGenericSeat(email);
    const preferred = preferredGenericOwnerId({
      mailboxClientId: account.client_id,
      assignedClientId: seat?.assignedClientId ?? pool?.assignedClientId ?? null,
      assignedReason: seat?.reason,
      powerGrydClientId: this.config.powerGrydClientId,
    });
    if (preferred != null && preferred !== clientId) return false;
    if (preferred === clientId) return true;
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

  /**
   * D254 — one-client + on-week-POD lock used by named and POC fills.
   * Off-week locked PODs and another client's assignment are a hard no
   * before any campaign link.
   */
  private genericMayFillNow(
    account: SmartleadAccountWithCampaigns,
    email: string,
    clientId: number,
    now: Date,
  ): boolean {
    if (!genericMayLinkToCampaigns(account, now)) return false;
    if (this.powerGrydStaffingBlocked(account, email, clientId)) return false;
    return this.genericMayTakePod(account, email, clientId, onWeekCohort(now));
  }

  /** D283 — never walk the 800-row pool for PowerGRYD. Named seats only. */
  private neverGenericClient(clientId: number): boolean {
    return (
      isPowerGrydClientId(clientId) ||
      clientId === this.config.powerGrydClientId
    );
  }

  /** D258 — hard block foreign-client / foreign-sig generics onto PowerGRYD. */
  private powerGrydStaffingBlocked(
    account: SmartleadAccountWithCampaigns,
    email: string,
    clientId: number,
  ): boolean {
    const seat = this.state.getGenericSeat(email);
    const pool = this.state.getPoolMailbox(email);
    return genericBlockedOnPowerGrydStaffing({
      account,
      email,
      targetClientId: clientId,
      emptyByDesign: this.powerGrydEmptyByDesign,
      powerGrydClientId: this.config.powerGrydClientId,
      powerGrydBrand: this.powerGrydBrand,
      allBrands: this.allClientBrands,
      mailboxClientId:
        typeof account.client_id === "number" ? account.client_id : null,
      assignedClientId: seat?.assignedClientId ?? pool?.assignedClientId ?? null,
      isMarkerClientId: (id) => this.state.isMarkerClientId(id),
    });
  }

  private async stampGenericPod(
    account: SmartleadAccountWithCampaigns,
    email: string,
    clientId: number,
    pod: "A" | "B",
    dryRun: boolean,
  ): Promise<void> {
    const locked = lockedGenericPod({
      tags: account.tags,
      assignedPod: this.state.getGenericSeat(email)?.assignedPod,
    });
    if (locked === pod) return;
    if (locked != null) {
      console.warn(
        `[min40] D234 refuse POD retag ${email} has=POD-${locked} want=POD-${pod}`,
      );
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

  private async stampPocReservation(
    account: SmartleadAccountWithCampaigns,
    email: string,
    clientId: number,
    dryRun: boolean,
  ): Promise<void> {
    if (
      !dryRun &&
      typeof account.id === "number" &&
      this.smartlead.ensureTag &&
      this.smartlead.assignTags
    ) {
      const tag = await this.smartlead.ensureTag(POC_TAG, "#8E24AA");
      await this.smartlead.assignTags([account.id], [tag.id]);
      await sleep(WRITE_GAP_MS);
    }
    const tags = (account.tags ?? []).map((tag) =>
      typeof tag === "string" ? { tag_name: tag } : tag,
    );
    if (!hasPocReservationTag({ tags })) {
      account.tags = [...tags, { tag_name: POC_TAG }];
    }
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
      reason: GENERIC_ASSIGN_REASON_POC_ENGAGEMENT,
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
    pocEngagement?: boolean;
    now?: Date;
  }): Promise<boolean> {
    if (typeof input.account.id !== "number") return false;
    if (isLockedCanarySeat(input.account, input.email, this.state)) return false;
    if (
      input.now &&
      isGenericMailbox(input.account, input.email, this.config, this.state) &&
      !this.genericMayFillNow(
        input.account,
        input.email,
        input.clientId,
        input.now,
      )
    ) {
      return false;
    }
    if (isGabeVmReserved(input.account)) return false;
    if (
      isCallerFollowUpSupplyBlocked(
        input.account,
        input.email,
        callerFollowUpPolicyFromConfig(this.config),
      )
    ) {
      return false;
    }
    if (
      !callerFollowUpMayAttach({
        email: input.email,
        account: input.account,
        campaign: input.campaign,
        warmed: true,
        policy: callerFollowUpPolicyFromConfig(this.config),
      }).ok
    ) {
      return false;
    }
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
            reason: input.pocEngagement
              ? GENERIC_ASSIGN_REASON_POC_ENGAGEMENT
              : GENERIC_ASSIGN_REASON_POD_TOP_UP,
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
    seats: IndexedSeat[];
    members: IndexedSeat[];
    campaignById: Map<number, SmartleadCampaign>;
    accountById: Map<number, SmartleadAccountWithCampaigns>;
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>;
    brandByClientId: Map<number, string>;
    namedOnWeek: Set<string>;
    clientActive: SmartleadCampaign[];
    result: Min40TopUpResult;
    pocEngagement?: boolean;
    target?: number;
    signal?: AbortSignal;
    poolMailboxes?: PoolMailboxRecord[];
  }): Promise<number> {
    const brand =
      input.brandByClientId.get(input.clientId) ||
      input.clientName.replace(/\s*\(.*?\)\s*$/, "").trim() ||
      input.clientName;
    const selected = new Set<string>();
    let placed = 0;
    const poolMailboxes = input.poolMailboxes ?? this.state.listPoolMailboxes();
    const rejectedPreferNonAzure = new Set<string>();
    const rejectedAny = new Set<string>();

    const skipPoolGenerics = this.neverGenericClient(input.clientId);
    const existing: IndexedSeat[] = [];
    let scanned = 0;
    for (const seat of input.seats) {
      if (input.signal?.aborted) break;
      scanned += 1;
      if (scanned % MIN40_SEAT_YIELD_EVERY === 0) await yieldEventLoop();
      if (selected.has(seat.email)) continue;
      if (seat.campaignIds.has(input.campaign.id)) continue;
      if (!seat.peelStaffable) continue;
      if (!this.seatIsUsable(seat.account, seat.email, input.campaign, input.campaignById)) {
        continue;
      }
      if (seat.generic) {
        if (!this.belongsToClient(seat.account, seat.email, input.clientId, input.campaignById)) {
          continue;
        }
        if (
          this.genericMayFillNow(
            seat.account,
            seat.email,
            input.clientId,
            input.now,
          )
        ) {
          existing.push(seat);
        }
        continue;
      }
      if (input.namedOnWeek.has(seat.email)) existing.push(seat);
    }
    existing.sort((a, b) => {
      if (a.generic !== b.generic) return a.generic ? 1 : -1;
      return a.email.localeCompare(b.email);
    });

    const espCounts = { GOOGLE: 0, MICROSOFT: 0 };
    for (const seat of input.members) {
      const slot = mailboxEspSlot(seat.account);
      if (slot) espCounts[slot] += 1;
    }

    for (const seat of existing) {
      if (input.signal?.aborted) break;
      if (placed >= input.shortBy - 1e-9) break;
      const email = seat.email;
      const account = seat.account;
      const needed = espFillOrder(
        espCounts,
        input.target ?? minFloorForClient(input.clientId, this.config.minFloorByClient),
        Math.round(POD_ESP_MIX_MIN_FRACTION * 100),
      );
      const slot = mailboxEspSlot(account);
      if (needed.length === 1 && slot && slot !== needed[0]) continue;
      const ok = await this.attachSeat({
        account,
        email,
        campaign: input.campaign,
        clientId: input.clientId,
        dryRun: input.dryRun,
        result: input.result,
        pocEngagement: input.pocEngagement,
        now: input.now,
      });
      if (ok) {
        selected.add(email);
        placed = roundStaffableWeight(placed + seat.weight);
        if (slot) espCounts[slot] += 1;
      }
    }

    while (!skipPoolGenerics && placed < input.shortBy - 1e-9) {
      if (input.signal?.aborted) break;
      const platformOrder = espFillOrder(
        espCounts,
        input.target ?? ON_WEEK_MIN_SENDERS,
        Math.round(POD_ESP_MIX_MIN_FRACTION * 100),
      );
      const canTake = (email: string, preferNonAzure: boolean): boolean => {
        const key = email.toLowerCase();
        const poolAccount = input.accountByEmail.get(key);
        if (selected.has(key)) return false;
        if (!poolAccount) return false;
        if (campaignIdsOf(poolAccount).includes(input.campaign.id)) {
          return false;
        }
        if (!this.seatIsUsable(poolAccount, key, input.campaign, input.campaignById)) {
          return false;
        }
        if (!isPoolGenericSeat(poolAccount, key, this.config, this.state)) {
          return false;
        }
        if (!this.state.getGenericSeat(key)) return false;
        if (hasPocReservationTag(poolAccount)) {
          if (!input.pocEngagement || poolAccount.client_id !== input.clientId) {
            return false;
          }
        }
        if (!this.genericMayFillNow(poolAccount, key, input.clientId, input.now)) {
          return false;
        }
        if (
          preferNonAzure &&
          classifyMailboxSendType(poolAccount) === "azure"
        ) {
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
      };
      const pickOpts = {
        signal: input.signal,
        isCopyCanary: (email: string) => this.state.isCopyCanary(email),
        getRestingInbox: (email: string) => this.state.getRestingInbox(email),
      };
      const pool =
        (await findReassignablePoolMailboxYielding(
          poolMailboxes,
          platformOrder,
          (email) => canTake(email, true),
          { ...pickOpts, rejected: rejectedPreferNonAzure },
        )) ??
        (await findReassignablePoolMailboxYielding(
          poolMailboxes,
          platformOrder,
          (email) => canTake(email, false),
          { ...pickOpts, rejected: rejectedAny },
        ));
      if (!pool?.smartleadAccountId) break;
      const original = input.accountByEmail.get(pool.email.toLowerCase());
      if (!original) {
        this.state.removePoolMailbox(pool.email);
        rejectedPreferNonAzure.add(pool.email.toLowerCase());
        rejectedAny.add(pool.email.toLowerCase());
        continue;
      }
      if (!this.genericMayFillNow(original, pool.email, input.clientId, input.now)) {
        rejectedPreferNonAzure.add(pool.email.toLowerCase());
        rejectedAny.add(pool.email.toLowerCase());
        continue;
      }
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
          const fromName = `${firstName} ${lastName}`;
          await this.smartlead.updateEmailAccount(pool.smartleadAccountId, {
            signature: insightTarget
              ? INSIGHT_MAILBOX_SIGNATURE_BLANK
              : input.pocEngagement
                ? pocSignature(fromName, brand)
                : buildPoolSignature({ firstName, lastName, clientBrand: brand }),
            from_name: fromName,
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
          if (input.pocEngagement) {
            await this.stampPocReservation(
              original,
              pool.email,
              input.clientId,
              input.dryRun,
            );
          } else {
            await this.stampGenericPod(
              original,
              pool.email,
              input.clientId,
              onWeekCohort(input.now),
              input.dryRun,
            );
          }
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
    seats: IndexedSeat[];
    campaigns: SmartleadCampaign[];
    campaignById: Map<number, SmartleadCampaign>;
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>;
    brandByClientId: Map<number, string>;
    activeByClient: Map<number, SmartleadCampaign[]>;
    result: Min40TopUpResult;
    pocIds: number[];
    signal?: AbortSignal;
    poolMailboxes?: PoolMailboxRecord[];
    synced?: GenericPoolSyncResult;
  }): Promise<void> {
    const synced =
      input.synced ??
      (await syncGenericSeatsFromInventory({
        existing: this.state.listGenericSeats(),
        accounts: input.accounts,
        campaigns: input.campaigns,
        config: this.config,
        state: this.state,
        now: input.now,
        powerGrydClientId: this.config.powerGrydClientId,
        pocEngagementClientIds: input.pocIds,
      }));
    if (!input.dryRun && !input.synced) {
      this.state.replaceGenericSeats(synced.seats);
    }
    const poolMailboxes = input.poolMailboxes ?? this.state.listPoolMailboxes();
    const onWeek = onWeekCohort(input.now);
    for (const [clientId, clientActive] of input.activeByClient) {
      if (input.signal?.aborted) {
        input.result.errors.push("aborted: stopped remaining POD fills");
        break;
      }
      if (input.pocIds.includes(clientId)) continue;
      if (this.neverGenericClient(clientId)) continue;
      const floor = minFloorForClient(clientId, this.config.minFloorByClient);
      const brand = input.brandByClientId.get(clientId) || String(clientId);
      const selected = new Set<string>();
      // D268 — new generics only top up the on-week POD. Named A/B
      // tables staff the off-week cylinder; do not keep assigning
      // pool seats there.
      for (const pod of ["A", "B"] as const) {
        if (pod !== onWeek) continue;
        const named = synced.namedStaffableByClientPod.get(clientPodKey(clientId, pod)) ?? 0;
        // Live table + this-run attaches — the start-of-pass snapshot
        // does not include fillCampaign's just-placed generics, and
        // using it would add past the floor (D268).
        const assignedEmails = new Set<string>();
        for (const seat of this.state.listGenericSeats()) {
          if (seat.assignedClientId === clientId && seat.assignedPod === pod) {
            assignedEmails.add(seat.email.toLowerCase());
          }
        }
        if (pod === onWeek) {
          for (const row of input.result.assigned) {
            if (row.clientId === clientId) {
              assignedEmails.add(row.email.toLowerCase());
            }
          }
        }
        let assigned = 0;
        for (const email of assignedEmails) {
          const seat = this.state.getGenericSeat(email);
          assigned = roundStaffableWeight(
            assigned + (seat ? seatStaffableWeight(seat) : 1),
          );
        }
        let need = podInventoryNeed(named, assigned, floor);
        const espCounts = { GOOGLE: 0, MICROSOFT: 0 };
        let espN = 0;
        for (const seat of input.seats) {
          espN += 1;
          if (espN % MIN40_SEAT_YIELD_EVERY === 0) await yieldEventLoop();
          const account = seat.account;
          const assignedHere =
            typeof account.client_id === "number" &&
            account.client_id === clientId &&
            mailboxPodOf(account) === pod;
          const namedHere =
            !seat.generic &&
            typeof account.client_id === "number" &&
            account.client_id === clientId &&
            (mailboxPodOf(account) === pod || mailboxPodOf(account) == null);
          if (!assignedHere && !namedHere) continue;
          const slot = mailboxEspSlot(account);
          if (slot) espCounts[slot] += 1;
        }
        await yieldEventLoop();
        const rejected = new Set<string>();
        while (need > 1e-9) {
          if (input.signal?.aborted) break;
          const platforms = espFillOrder(
            espCounts,
            floor,
            Math.round(POD_ESP_MIX_MIN_FRACTION * 100),
          );
          const pool = await findReassignablePoolMailboxYielding(
            poolMailboxes,
            platforms,
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
              if (this.powerGrydStaffingBlocked(account, email, clientId)) {
                return false;
              }
              if (hasPocReservationTag(account) && owner !== clientId) return false;
              if (lockedGenericPod({ tags: account.tags }) === pod) return false;
              if (!this.seatIsUsable(account, email, clientActive[0]!, input.campaignById)) {
                return false;
              }
              return this.genericMayTakePod(account, email, clientId, pod);
            },
            {
              rejected,
              signal: input.signal,
              isCopyCanary: (email) => this.state.isCopyCanary(email),
              getRestingInbox: (email) => this.state.getRestingInbox(email),
            },
          );
          if (!pool?.smartleadAccountId) break;
          const original = input.accountByEmail.get(pool.email.toLowerCase());
          if (!original) {
            this.state.removePoolMailbox(pool.email);
            rejected.add(pool.email.toLowerCase());
            continue;
          }
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
            const placedSlot = mailboxEspSlot(original);
            if (placedSlot) espCounts[placedSlot] += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            input.result.errors.push(`${pool.email} POD ${pod}: ${message}`);
            break;
          }
        }
      }
    }
  }

  /**
   * D254 — every named client (including PowerGRYD) reports its
   * on-week POD shortfall. Zero on-week generics on a still-short
   * POD is an alert, not a hands-off watch. Need uses that
   * client's min-floor (D256).
   */
  private reportOnWeekPodShortfalls(input: {
    now: Date;
    namedStaffableByClientPod: Map<string, number>;
    activeByClient: Map<number, SmartleadCampaign[]>;
    clientsById: Map<number, SmartleadClientRecord>;
    pocIds: number[];
    result: Min40TopUpResult;
  }): void {
    const onWeek = onWeekCohort(input.now);
    const seats = this.state.listGenericSeats();
    for (const [clientId, campaigns] of input.activeByClient) {
      if (input.pocIds.includes(clientId)) continue;
      const named =
        input.namedStaffableByClientPod.get(clientPodKey(clientId, onWeek)) ?? 0;
      const assignedSeats = seats.filter(
        (seat) =>
          seat.assignedClientId === clientId && seat.assignedPod === onWeek,
      );
      const assigned = assignedSeats.reduce(
        (sum, seat) => sum + seatStaffableWeight(seat),
        0,
      );
      const floor = minFloorForClient(clientId, this.config.minFloorByClient);
      const need = podInventoryNeed(named, assigned, floor);
      const client = input.clientsById.get(clientId);
      const clientName = clientDisplayName(client ?? { id: clientId });
      if (assigned < 1e-9 && need > 1e-9) {
        input.result.alerts.push(
          `${clientName} on-week POD-${onWeek} has 0 generics (short ${displayShortfallSenders(need)}).`,
        );
      }
      if (need <= 1e-9) continue;
      if (input.result.unfilled.some((row) => row.clientId === clientId)) {
        continue;
      }
      const first = campaigns[0];
      if (!first) continue;
      input.result.unfilled.push({
        campaignId: first.id,
        name: `${clientName} on-week POD-${onWeek}`,
        shortBy: need,
        floor,
        clientId,
        clientName,
      });
    }
  }

  private async alertUnfilled(
    result: Min40TopUpResult,
    todayYmd: string,
    dryRun: boolean,
  ): Promise<void> {
    if (!this.slack) return;
    const grouped = groupShortStaffedByClient(result.unfilled);
    const snapshot = shortStaffedSnapshot(grouped);
    const emptyPod = result.alerts
      .filter((line) => /on-week POD-[AB] has 0 generics/.test(line))
      .join("\n");
    const staffed = shortStaffedLines(grouped);
    const text = [staffed, emptyPod].filter(Boolean).join("\n") || null;
    if (!text) {
      if (this.state.getShortStaffedSnapshot()) {
        this.state.setShortStaffedSnapshot("");
      }
      return;
    }
    const snapKey = `${snapshot}::${emptyPod}`;
    if (this.state.getShortStaffedSnapshot() === snapKey) return;
    console.warn(`[min40-topup] ${text.replace(/\n/g, " | ")}`);
    if (!result.alerts.includes(text)) result.alerts.push(text);
    if (!dryRun) {
      try {
        await this.slack.send(text, undefined, "short_staffed");
        this.state.setShortStaffedSnapshot(snapKey);
        for (const row of result.unfilled) {
          this.state.setMin40ShortfallAlerted(`campaign:${row.campaignId}`, todayYmd);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`short-staffed slack: ${message}`);
      }
    }
  }

}
