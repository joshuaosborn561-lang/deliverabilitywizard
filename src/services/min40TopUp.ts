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
} from "../lib/genericPool.js";
import {
  classifyMailboxSendType,
  mailboxEspSlot,
  mailboxStaffableWeight,
  roundStaffableWeight,
} from "../lib/mailboxType.js";
import { syncGenericSeatsFromInventory } from "../lib/genericPoolCanon.js";
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
import type { InboxkitClientSplitCache } from "../lib/inboxkitClientSplit.js";
import { chicagoWallClock, isCanonOpsBusinessHours } from "../lib/canonOpsHours.js";
import {
  isRealNamedClientId,
  preferredGenericOwnerId,
  resolveDedicatedGenericClientId,
} from "../lib/dedicatedGeneric.js";
import {
  brandsFromClients,
  genericBlockedOnPowerGrydStaffing,
  powerGrydBrandFromClients,
} from "../lib/powerGrydEmptyByDesign.js";
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
  logCompanyFallback,
  logPlaceholderRefusal,
  resolveSendIdentity,
} from "../lib/personaName.js";
import {
  genericEligibleForClientPod,
  genericPodTagColor,
  genericPodTagName,
  lockedGenericPod,
  stampMailboxPodTag,
  stripMailboxPodTags,
} from "../lib/genericAssign.js";
import { genericMayLinkToCampaigns, mailboxPodOf } from "../lib/podInventory.js";
import {
  alreadyCoveredEmails,
  freeWarmGenericCount,
  isFreeWarmLedgerSeat,
  linkCoveringFor,
  pendingRetireDomains,
  pickFreeWarmGenericsForPod,
  suppressPodFloorAlert,
  warmReadyAtFromClock,
  warmingSeatsByClientPod,
  type WarmingBrandedSeat,
} from "../lib/genericLedger.js";
import {
  countOwnedClientPods,
  formatPodFloorAlert,
  ownedNamedClientIdForSeat,
  ownedPodMap,
  type OwnedPodCount,
} from "../lib/podOwnedInventory.js";
import { assignClientCohorts, onWeekCohort } from "../lib/restCohort.js";
import { mailboxMessagePerDayTarget } from "../lib/sendCeiling.js";
import { accountOnBounceHold } from "../lib/bounceHold.js";
import { sleep } from "../lib/http.js";
import { dropGhostPoolSeats } from "../lib/poolInventoryReconcile.js";
import { findReassignablePoolMailboxYielding } from "../lib/poolPick.js";
import { createLoopYielder, createTimeSlicer, yieldEventLoop } from "../lib/stringifyYielding.js";
import type { PoolMailboxRecord } from "../state/store.js";
import {
  INSIGHT_MAILBOX_SIGNATURE_BLANK,
  insightExemptFromSenderTopUp,
  isInsightCampaignId,
  isInsightClientId,
} from "../lib/insightCampaigns.js";
import type { StateStore } from "../state/store.js";
import {
  activeHoldUntilDate,
  owesWarmup,
  tagNames,
  warmupClockStartedAt,
} from "./warmupGate.js";
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
  pod?: "A" | "B";
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
    pod?: "A" | "B";
    owned?: number;
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
 * D285 — min-40 is per POD, not per campaign. Each named client's
 * POD A and POD B independently need >= floor warm staffable seats
 * the client owns (40, TechEvo 30). Count client-owned named seats
 * plus generics assigned to that client and POD. Seats sitting on
 * another client's campaigns never count. When either POD is under
 * floor, assign free warm untagged pool generics through
 * state.genericSeats. On-week campaigns link only the on-week POD;
 * the off-week POD's generics stay assigned and unlinked (D228).
 * Insight 582890 is the only client that never gets generics
 * (`insightExemptFromSenderTopUp`); it is still counted and
 * alerted (Josh-only seats). PowerGRYD 592842 takes generics
 * like any named client. D283 still refuses Onboarding-freed
 * seats that would flip back to PowerGRYD ownership.
 * Never retag named seats. Never retag a generic across PODs (D230).
 * Never START/PAUSE. Never CornerStone or HOLD-UNTIL/RETIRE.
 * D268 — no Allow-generics Slack card and no auto-allow list.
 * Never add generics past the floor. Never add them when owned
 * seats already cover that POD.
 * D256 — fill to that client's min-floor (`MIN_FLOOR_BY_CLIENT`,
 * default 40; TechEvo 30) and return surplus generics above it.
 * D254 — POC fills stay campaign-level 60 with the one-client /
 * on-week-POD lock.
 */
export class Min40TopUpService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly clientSplits?: InboxkitClientSplitCache,
  ) {}

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
    await this.clientSplits?.ensureLoaded();
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
    // D292 — pick/getGenericSeat read wizard state. Always seed in
    // memory so a dry run still assigns. Persist stays !dryRun (save).
    this.state.replaceGenericSeats(seeded.seats);
    console.log(
      `[min40-topup] ledger seats=${seeded.seats.length} freeWarm=${freeWarmGenericCount(seeded.seats, now)} dryRun=${dryRun}`,
    );
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
    this.powerGrydBrand = powerGrydBrandFromClients(
      clients,
      this.config.powerGrydClientId,
    );
    this.allClientBrands = brandsFromClients(clients);
    const seatIndex = await this.indexSeats(
      accounts as SmartleadAccountWithCampaigns[],
      opts.signal,
    );
    const namedOnWeek = await this.namedOnWeekEmails(
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
      } else {
        // D285 — named-client min-40 is POD inventory, not per campaign.
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
      });
    }

    if (!opts.signal?.aborted) {
      await this.shareOnWeekAssignedGenerics({
        dryRun,
        now,
        seats: seatIndex.seats,
        campaignById,
        activeByClient,
        pocIds,
        result,
        signal: opts.signal,
      });
    }

    await this.reportPodShortfalls({
      now,
      accounts: accounts as SmartleadAccountWithCampaigns[],
      campaigns: campaigns as SmartleadCampaign[],
      activeByClient,
      clientsById,
      pocIds,
      result,
    });

    await this.alertUnfilled(result, todayYmd, dryRun, now);

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
    for (const message of result.errors) {
      console.warn(`[min40-topup] error: ${message}`);
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
    const slice = createTimeSlicer();
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
      else await slice();
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
    const slice = createTimeSlicer();
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
      else await slice();
    }
    return byClient;
  }

  private async namedOnWeekEmails(
    seats: IndexedSeat[],
    campaigns: SmartleadCampaign[],
    clients: SmartleadClientRecord[],
    onWeek: "A" | "B",
  ): Promise<Map<number, Set<string>>> {
    const byClient = new Map<number, Array<{ email: string; type?: string | null }>>();
    const taggedByEmail = new Map<string, "A" | "B">();
    const campaignClient = new Map(campaigns.map((c) => [c.id, c.client_id]));
    const yieldSeat = createLoopYielder(MIN40_SEAT_YIELD_EVERY);
    for (const seat of seats) {
      await yieldSeat();
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
    // D292 — ledger assignedClientId is source of truth. A leftover
    // poolMailboxes.assignedClientId must not lock a free ledger seat.
    return genericEligibleForClientPod({
      clientId,
      targetPod,
      mailboxClientId: typeof account.client_id === "number" ? account.client_id : null,
      assignedClientId: seat.assignedClientId ?? null,
      assignedReason: seat.reason,
      releaseHistory: seat.releaseHistory,
      tags: account.tags,
      assignedPod: seat.assignedPod ?? null,
      excluded: seat.excluded,
      email,
      isMarkerClientId: (id) => this.state.isMarkerClientId(id),
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

  /**
   * D282 / D285 — Insight is the only client that never gets
   * generics. insightExemptFromSenderTopUp is the no-backfill gate.
   * PowerGRYD takes generics; D283 only blocks Onboarding-freed
   * seats from flipping back onto 592842.
   */
  private neverGenericClient(clientId: number): boolean {
    return insightExemptFromSenderTopUp({ client_id: clientId }) || isInsightClientId(clientId);
  }

  /** D258 — hard block foreign-client / foreign-sig generics onto PowerGRYD. */
  private powerGrydStaffingBlocked(
    account: SmartleadAccountWithCampaigns,
    email: string,
    clientId: number,
  ): boolean {
    const seat = this.state.getGenericSeat(email);
    return genericBlockedOnPowerGrydStaffing({
      account,
      email,
      targetClientId: clientId,
      emptyByDesign: false,
      powerGrydClientId: this.config.powerGrydClientId,
      powerGrydBrand: this.powerGrydBrand,
      allBrands: this.allClientBrands,
      mailboxClientId:
        typeof account.client_id === "number" ? account.client_id : null,
      // D292 — leftover poolMailboxes.assignedClientId must not lock
      // a ledger-free seat. Ledger assignedClientId is the owner.
      assignedClientId: seat?.assignedClientId ?? null,
      assignedReason: seat?.reason ?? null,
      releaseHistory: seat?.releaseHistory,
      isMarkerClientId: (id) => this.state.isMarkerClientId(id),
    });
  }

  private async stampGenericPod(
    account: SmartleadAccountWithCampaigns,
    email: string,
    clientId: number,
    pod: "A" | "B",
    dryRun: boolean,
    coveringFor?: ReturnType<typeof linkCoveringFor>,
  ): Promise<boolean> {
    const table = this.state.getGenericSeat(email);
    const ledgerFree = table?.assignedClientId == null && table?.assignedPod == null;
    const leftoverTag = lockedGenericPod({ tags: account.tags });
    // D292 — leftover POD tags on a free ledger seat are stale (D286).
    // Strip them and stamp the needed POD. Assigned seats still cannot
    // move PODs (D230/D234).
    const locked = ledgerFree
      ? null
      : lockedGenericPod({
          tags: account.tags,
          assignedPod: table?.assignedPod,
        });
    if (locked != null && locked !== pod) {
      console.warn(
        `[min40] D234 refuse POD retag ${email} has=POD-${locked} want=POD-${pod}`,
      );
      return false;
    }
    if (
      ledgerFree &&
      leftoverTag != null &&
      leftoverTag !== pod &&
      !dryRun &&
      typeof account.id === "number" &&
      this.smartlead.ensureTag &&
      this.smartlead.removeTags
    ) {
      const tagA = await this.smartlead.ensureTag(genericPodTagName("A"), genericPodTagColor("A"));
      const tagB = await this.smartlead.ensureTag(genericPodTagName("B"), genericPodTagColor("B"));
      await this.smartlead.removeTags([account.id], [tagA.id, tagB.id]);
      account.tags = stripMailboxPodTags(account.tags);
      await sleep(WRITE_GAP_MS);
    }
    if (
      locked == null &&
      !dryRun &&
      typeof account.id === "number" &&
      this.smartlead.ensureTag &&
      this.smartlead.assignTags
    ) {
      const tag = await this.smartlead.ensureTag(genericPodTagName(pod), genericPodTagColor(pod));
      await this.smartlead.assignTags([account.id], [tag.id]);
      await sleep(WRITE_GAP_MS);
    }
    account.tags = stampMailboxPodTag(account.tags, pod);
    if (dryRun) return true;
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
      coveringFor,
    });
    if (!assigned.ok) {
      console.warn(
        `[min40] refused generic table assign ${email}: ${assigned.error}`,
      );
      return false;
    }
    return true;
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
    const microsoftShare =
      this.clientSplits?.shareForClient(input.clientName) ??
      this.clientSplits?.shareForClient(brand);
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
        undefined,
        microsoftShare,
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
        undefined,
        microsoftShare,
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
      // Every inbox has a name (Josh 2026-10-29). Persona from the ledger /
      // InboxKit pool row or the live mailbox; none -> send as the company.
      // Never "Pool User", never an invented name.
      const identity = resolveSendIdentity({
        email: pool.email,
        pool,
        liveFromName: original.from_name,
        clientBrand: brand,
        knownBrands: [...input.brandByClientId.values()],
      });
      if (!identity) {
        logPlaceholderRefusal("min40-topup/short-campaign", pool.email, original.from_name);
        rejectedPreferNonAzure.add(pool.email.toLowerCase());
        rejectedAny.add(pool.email.toLowerCase());
        continue;
      }
      if (identity.source === "company") {
        logCompanyFallback("min40-topup/short-campaign", pool.email, brand, original.from_name);
      }
      try {
        if (!input.dryRun) {
          await this.smartlead.addEmailAccountsToCampaign(input.campaign.id, [
            pool.smartleadAccountId,
          ]);
          recordMembership(original, input.campaign.id);
          await sleep(WRITE_GAP_MS);
          const insightTarget = isInsightCampaignId(input.campaign.id);
          const fromName = identity.fromName;
          await this.smartlead.updateEmailAccount(pool.smartleadAccountId, {
            signature: insightTarget
              ? INSIGHT_MAILBOX_SIGNATURE_BLANK
              : input.pocEngagement
                ? identity.source === "company"
                  ? identity.signature
                  : pocSignature(fromName, brand)
                : identity.signature,
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

  /**
   * D285 — thin floor-only top-up of **both** POD-A and POD-B.
   * Count owned inventory per POD, never per campaign. Never skip
   * the off-week POD. Never add them when named / owned seats
   * already cover that POD. Never add generics past the floor.
   * Off-week POD generics stay assigned and unlinked (D228).
   * Insight is counted here and gets no generics. PowerGRYD
   * takes generics like any named client.
   */
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
  }): Promise<void> {
    const poolMailboxes = input.poolMailboxes ?? this.state.listPoolMailboxes();
    const onWeek = onWeekCohort(input.now);
    const retirePending = pendingRetireDomains({
      actions: this.state.listIsolationActions(),
      history: this.state.listDomainHistory(),
    });
    const warmingBranded = await this.warmingBrandedSeats(
      input.accounts,
      input.campaignById,
      input.now,
    );
    const warmingByPod = warmingSeatsByClientPod(warmingBranded);
    let covered = alreadyCoveredEmails(this.state.listGenericSeats());
    const owned = ownedPodMap(
      await countOwnedClientPods({
        accounts: input.accounts,
        campaigns: input.campaigns,
        config: this.config,
        state: this.state,
        clientIds: input.activeByClient.keys(),
        now: input.now,
      }),
    );
    for (const [clientId, clientActive] of input.activeByClient) {
      if (input.signal?.aborted) {
        input.result.errors.push("aborted: stopped remaining POD fills");
        break;
      }
      if (input.pocIds.includes(clientId)) continue;
      const floor = minFloorForClient(clientId, this.config.minFloorByClient);
      const brand = input.brandByClientId.get(clientId) || String(clientId);
      const selected = new Set<string>();
      const skipGenerics = this.neverGenericClient(clientId);
      const microsoftShare = this.clientSplits?.shareForClient(brand);
      // D285 — both PODs. Never skip the off-week POD. On-week first
      // so a scarce generic links. D268's off-week skip is retired.
      const pods: Array<"A" | "B"> = onWeek === "B" ? ["B", "A"] : ["A", "B"];
      for (const pod of pods) {
        if (input.signal?.aborted) {
          input.result.errors.push(
            `aborted: stopped ${brand} POD-${pod} fill`,
          );
          break;
        }
        const row = owned.get(clientPodKey(clientId, pod));
        let need = row?.shortBy ?? floor;
        const espCounts = { GOOGLE: 0, MICROSOFT: 0 };
        const yieldEsp = createLoopYielder(MIN40_SEAT_YIELD_EVERY);
        for (const seat of input.seats) {
          await yieldEsp();
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
        if (skipGenerics) continue;
        const askedNeed = need;
        if (askedNeed > 1e-9) {
          input.result.asked.push({
            campaignId: clientActive[0]?.id ?? 0,
            name: `${brand} POD-${pod}`,
            shortBy: askedNeed,
          });
        }
        const rejected = new Set<string>();
        const poolHasBothEsps = this.state.listGenericSeats().some((row) => {
          if (!isFreeWarmLedgerSeat(row, input.now)) return false;
          return row.provider === "GOOGLE";
        }) && this.state.listGenericSeats().some((row) => {
          if (!isFreeWarmLedgerSeat(row, input.now)) return false;
          return row.provider === "MICROSOFT";
        });
        const bothEsps =
          (microsoftShare != null && microsoftShare > 0 && microsoftShare < 1) ||
          poolHasBothEsps ||
          (espCounts.GOOGLE > 0 && espCounts.MICROSOFT > 0);
        const neededEsp = espFillOrder(
          espCounts,
          floor,
          Math.round(POD_ESP_MIX_MIN_FRACTION * 100),
          bothEsps,
          microsoftShare,
        );
        const ledgerPicks = pickFreeWarmGenericsForPod({
          seats: this.state.listGenericSeats(),
          need,
          limit: 10_000,
          preferProvider: neededEsp[0],
          alreadyPicked: selected,
          retirePendingDomains: retirePending,
          now: input.now,
        });
        const yieldPicked = createLoopYielder(MIN40_SEAT_YIELD_EVERY);
        let rejectedWrongEsp = 0;
        const rejectReasons = new Map<string, number>();
        const noteReject = (reason: string): void => {
          rejectReasons.set(reason, (rejectReasons.get(reason) ?? 0) + 1);
        };
        for (const seat of ledgerPicks) {
          await yieldPicked();
          if (need <= 1e-9) break;
          if (input.signal?.aborted) {
            input.result.errors.push(
              `aborted: stopped ${brand} POD-${pod} fill (need=${need})`,
            );
            break;
          }
          const key = seat.email.toLowerCase();
          if (selected.has(key) || rejected.has(key)) continue;
          const original = input.accountByEmail.get(key);
          if (!original || typeof original.id !== "number") {
            rejected.add(key);
            noteReject("missing-account");
            continue;
          }
          // D292 — ledger membership is enough. isPoolGenericSeat also
          // required a poolMailboxes row / extraGenericDomains host and
          // silently dropped every GENERIC-tag-only free seat.
          if (!isGenericMailbox(original, seat.email, this.config, this.state)) {
            rejected.add(key);
            noteReject("not-generic");
            continue;
          }
          const neededNow = espFillOrder(
            espCounts,
            floor,
            Math.round(POD_ESP_MIX_MIN_FRACTION * 100),
            bothEsps,
            microsoftShare,
          );
          const slot =
            mailboxEspSlot(original) ??
            (seat.provider === "GOOGLE" || seat.provider === "MICROSOFT"
              ? seat.provider
              : null);
          if (neededNow.length === 1 && slot && slot !== neededNow[0]) {
            rejectedWrongEsp += 1;
            noteReject(`wrong-esp:${slot}`);
            continue;
          }
          if (this.powerGrydStaffingBlocked(original, seat.email, clientId)) {
            rejected.add(key);
            noteReject("powergryd-blocked");
            continue;
          }
          if (
            hasPocReservationTag(original) &&
            original.client_id != null &&
            original.client_id !== clientId
          ) {
            rejected.add(key);
            noteReject("poc-reserved");
            continue;
          }
          // D292 — leftover Smartlead POD tags are not a lock on a
          // ledger-free seat. genericMayTakePod / genericEligibleForClientPod
          // own the one-client / one-POD rule (D230/D234).
          if (
            !this.genericMayTakePod(original, seat.email, clientId, pod)
          ) {
            rejected.add(key);
            noteReject("may-not-take-pod");
            continue;
          }
          const pool =
            poolMailboxes.find((row) => row.email.toLowerCase() === key) ??
            this.state.getPoolMailbox(key);
          // Every inbox has a name (Josh 2026-10-29): persona, else the company.
          const identity = resolveSendIdentity({
            email: seat.email,
            pool,
            liveFromName: original.from_name,
            clientBrand: brand,
            knownBrands: [...input.brandByClientId.values()],
          });
          if (!identity) {
            logPlaceholderRefusal("min40-topup/pod-fill", seat.email, original.from_name);
            rejected.add(key);
            noteReject("no-sender-name");
            continue;
          }
          if (identity.source === "company") {
            logCompanyFallback("min40-topup/pod-fill", seat.email, brand, original.from_name);
          }
          const covering = linkCoveringFor({
            seat: {
              ...seat,
              assignedClientId: clientId,
              assignedPod: pod,
            },
            warming: warmingBranded,
            warmingByPod,
            alreadyCovered: covered,
            now: input.now,
          });
          try {
            if (!input.dryRun) {
              await this.smartlead.updateEmailAccount(original.id, {
                signature: identity.signature,
                from_name: identity.fromName,
                client_id: clientId,
                time_to_wait_in_mins: this.config.mailboxMinTimeGapMins,
              });
              original.client_id = clientId;
              if (pool) {
                this.state.upsertPoolMailbox({
                  ...pool,
                  status: "assigned",
                  assignedClientId: clientId,
                  assignedAt: new Date().toISOString(),
                });
              }
              const stamped = await this.stampGenericPod(
                original,
                seat.email,
                clientId,
                pod,
                input.dryRun,
                covering,
              );
              if (!stamped) {
                rejected.add(key);
                noteReject("stamp-refused");
                continue;
              }
              if (pod === onWeek) {
                for (const campaign of clientActive) {
                  if (campaignIdsOf(original).includes(campaign.id)) continue;
                  if (!this.seatIsUsable(original, seat.email, campaign, input.campaignById)) {
                    continue;
                  }
                  await this.smartlead.addEmailAccountsToCampaign(campaign.id, [
                    original.id,
                  ]);
                  recordMembership(original, campaign.id);
                  await sleep(WRITE_GAP_MS);
                }
              }
            } else {
              const stamped = await this.stampGenericPod(
                original,
                seat.email,
                clientId,
                pod,
                true,
                covering,
              );
              if (!stamped) {
                rejected.add(key);
                noteReject("stamp-refused");
                continue;
              }
            }
            selected.add(key);
            for (const row of covering) covered.add(row.email);
            input.result.assigned.push({
              campaignId: pod === onWeek ? (clientActive[0]?.id ?? 0) : 0,
              campaignName: String(clientActive[0]?.name ?? clientId),
              email: seat.email,
              clientId,
              pod,
            });
            need = roundStaffableWeight(need - mailboxStaffableWeight(original));
            const placedSlot = mailboxEspSlot(original);
            if (placedSlot) espCounts[placedSlot] += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            input.result.errors.push(`${seat.email} ${brand} POD-${pod}: ${message}`);
            rejected.add(key);
            noteReject(`error:${message.slice(0, 80)}`);
            continue;
          }
        }
        if (askedNeed > 1e-9) {
          const reasons = [...rejectReasons.entries()]
            .map(([reason, n]) => `${reason}=${n}`)
            .join(",") || "none";
          console.log(
            `[min40-topup] ${brand} POD-${pod} need=${askedNeed} picks=${ledgerPicks.length} assignedNow=${askedNeed - need} rejected=${rejected.size} wrongEsp=${rejectedWrongEsp} reasons=${reasons}`,
          );
        }
      }
    }
  }

  private async warmingBrandedSeats(
    accounts: SmartleadAccountWithCampaigns[],
    campaignById: Map<number, SmartleadCampaign>,
    now: Date,
  ): Promise<WarmingBrandedSeat[]> {
    const out: WarmingBrandedSeat[] = [];
    const isMarker = this.state.isMarkerClientId?.bind(this.state);
    let scanned = 0;
    const slice = createTimeSlicer();
    for (const account of accounts) {
      scanned += 1;
      if (scanned % MIN40_SEAT_YIELD_EVERY === 0) await yieldEventLoop();
      else await slice();
      const email = accountEmail(account)?.toLowerCase();
      if (!email) continue;
      if (isGenericMailbox(account, email, this.config, this.state)) continue;
      if (!owesWarmup(account, email, this.config, this.state)) continue;
      const clientId = ownedNamedClientIdForSeat({
        account,
        email,
        campaignIds: campaignIdsOf(account),
        campaignById,
        isMarkerClientId: isMarker,
      });
      if (clientId == null) continue;
      const pod = mailboxPodOf(account);
      if (pod !== "A" && pod !== "B") continue;
      out.push({
        email,
        clientId,
        pod,
        warmReadyAt: warmReadyAtFromClock(
          warmupClockStartedAt(account, email, this.state),
          this.config.campaignMinWarmupDays ?? 21,
          now,
        ),
      });
    }
    return out;
  }

  /** D207 / D285 — on-week assigned generics sit on every ACTIVE campaign of that client. */
  private async shareOnWeekAssignedGenerics(input: {
    dryRun: boolean;
    now: Date;
    seats: IndexedSeat[];
    campaignById: Map<number, SmartleadCampaign>;
    activeByClient: Map<number, SmartleadCampaign[]>;
    pocIds: number[];
    result: Min40TopUpResult;
    signal?: AbortSignal;
  }): Promise<void> {
    const yieldSeat = createLoopYielder(MIN40_SEAT_YIELD_EVERY);
    for (const [clientId, clientActive] of input.activeByClient) {
      if (input.signal?.aborted) break;
      if (input.pocIds.includes(clientId)) continue;
      if (this.neverGenericClient(clientId)) continue;
      for (const seat of input.seats) {
        await yieldSeat();
        if (!seat.generic) continue;
        if (!this.belongsToClient(seat.account, seat.email, clientId, input.campaignById)) {
          continue;
        }
        if (!genericMayLinkToCampaigns(seat.account, input.now)) continue;
        if (
          !this.genericMayFillNow(
            seat.account,
            seat.email,
            clientId,
            input.now,
          )
        ) {
          continue;
        }
        for (const campaign of clientActive) {
          if (
            seat.campaignIds.has(campaign.id) ||
            campaignIdsOf(seat.account).includes(campaign.id)
          ) {
            continue;
          }
          if (!this.seatIsUsable(seat.account, seat.email, campaign, input.campaignById)) {
            continue;
          }
          const ok = await this.attachSeat({
            account: seat.account,
            email: seat.email,
            campaign,
            clientId,
            dryRun: input.dryRun,
            result: input.result,
            now: input.now,
          });
          if (ok) seat.campaignIds.add(campaign.id);
        }
      }
    }
  }

  /**
   * D254 / D285 — every named client POD (A and B, including Insight
   * and PowerGRYD) reports owned count vs floor after the fill.
   * `reportOnWeekPodShortfalls` is this walk; it no longer skips the
   * off-week POD.
   */
  private async reportPodShortfalls(input: {
    now: Date;
    accounts: SmartleadAccountWithCampaigns[];
    campaigns: SmartleadCampaign[];
    activeByClient: Map<number, SmartleadCampaign[]>;
    clientsById: Map<number, SmartleadClientRecord>;
    pocIds: number[];
    result: Min40TopUpResult;
  }): Promise<void> {
    const rows = await countOwnedClientPods({
      accounts: input.accounts,
      campaigns: input.campaigns,
      config: this.config,
      state: this.state,
      clientIds: input.activeByClient.keys(),
      now: input.now,
    });
    for (const row of rows) {
      if (input.pocIds.includes(row.clientId)) continue;
      if (row.shortBy <= 1e-9) continue;
      const campaigns = input.activeByClient.get(row.clientId) ?? [];
      const first = campaigns[0];
      const client = input.clientsById.get(row.clientId);
      const clientName = clientDisplayName(client ?? { id: row.clientId });
      if (
        input.result.unfilled.some(
          (existing) => existing.clientId === row.clientId && existing.pod === row.pod,
        )
      ) {
        continue;
      }
      input.result.unfilled.push({
        campaignId: first?.id ?? 0,
        name: `${clientName} POD-${row.pod}`,
        shortBy: row.shortBy,
        floor: row.floor,
        clientId: row.clientId,
        clientName,
        pod: row.pod,
        owned: row.owned,
      });
    }
  }

  /**
   * D285 — one Slack ops_alert to Josh per client POD per weekday
   * (6am–8pm CT) naming client, POD, owned count, and shortfall.
   */
  private async alertUnfilled(
    result: Min40TopUpResult,
    todayYmd: string,
    dryRun: boolean,
    now: Date,
  ): Promise<void> {
    if (!this.slack) return;
    const podRows = result.unfilled.filter(
      (row) => row.pod === "A" || row.pod === "B",
    );
    const lines: string[] = [];
    const stampKeys: string[] = [];
    for (const row of podRows) {
      if (row.clientId == null) continue;
      if (suppressPodFloorAlert(row.clientId)) continue;
      const key = `pod:${row.clientId}:${row.pod}`;
      if (this.state.getMin40ShortfallAlerted(key) === todayYmd) continue;
      const owned: OwnedPodCount = {
        clientId: row.clientId,
        pod: row.pod!,
        owned: row.owned ?? 0,
        named: 0,
        generics: 0,
        floor: row.floor ?? 40,
        shortBy: row.shortBy,
      };
      const line = formatPodFloorAlert(owned, row.clientName ?? row.name);
      lines.push(line);
      stampKeys.push(key);
    }
    const text = lines.join("\n") || null;
    if (!text) return;
    console.warn(`[min40-topup] ${text.replace(/\n/g, " | ")}`);
    if (!result.alerts.includes(text)) result.alerts.push(text);
    const inWindow = isCanonOpsBusinessHours({
      now,
      hourStart: 6,
      hourEnd: 20,
    });
    if (!dryRun && inWindow) {
      try {
        await this.slack.send(text, undefined, "ops_alert");
        for (const key of stampKeys) {
          this.state.setMin40ShortfallAlerted(key, todayYmd);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
                result.errors.push(`short-staffed slack: ${message}`);
      }
    }
  }

}
