import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { isBcpCampaignName, isBcpOwnedDomain } from "../lib/bcp.js";
import { senderIsAttachBlocked } from "../lib/attachBlock.js";
import { isRetiredSendingDomain } from "../lib/domainControl.js";
import { isGenericMailbox } from "../lib/clientInbox.js";
import { mailboxPodOf } from "../lib/podInventory.js";
import { resolveDedicatedGenericClientId } from "../lib/dedicatedGeneric.js";
import { isGabeVmReserved } from "../lib/canaryLock.js";
import {
  callerFollowUpExemptFromSenderTopUp,
  callerFollowUpMayAttach,
  callerFollowUpPolicyFromConfig,
  caydenSgRestMayDetach,
} from "../lib/callerFollowUp.js";
import { pocClientId, pocEngagementClientIds } from "../lib/pocClient.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { sleep } from "../lib/http.js";
import { pauseWhileOverdueCanonOps } from "../lib/healthCpuPause.js";
import { yieldEventLoop } from "../lib/stringifyYielding.js";
import {
  assignClientCohorts,
  isOffWeek,
  isoWeekNumberNy,
  onWeekCohort,
  type RestCohort,
} from "../lib/restCohort.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { canAttachMailboxToCampaign } from "../lib/insightCampaigns.js";
import {
  CIOTOLA_CLIENT_ID,
  isCiotolaCampaign,
  isJeremyCiotolaSeat,
} from "../lib/ciotolaClient.js";
import {
  countStaffableMemberships,
  detachWouldBreakStaffableFloor,
  noteStaffableAttach,
  noteStaffableDetach,
  ON_WEEK_MIN_SENDERS,
} from "../lib/clientStaffFloor.js";
import { isExcluded } from "./campaignTopUp.js";
import {
  dropMembership,
  fetchInventory,
  isSmartleadRateLimit,
  recordMembership,
  type InventorySnapshot,
} from "./inventory.js";
import { activeHoldUntilDate, owesWarmup, tagNames } from "./warmupGate.js";
import {
  clientIdFromRestGroupKey,
  isPodRotationSkippedClient,
} from "../lib/podRotation.js";
import {
  POD_SWAP_PASS_BUDGET_MS,
  freshPodSwap,
  podSwapAttachKey,
  podSwapDetachKey,
  podSwapForWeek,
  type PodSwapProgress,
} from "../lib/podSwapProgress.js";

/**
 * D43 — per-client A/B rest. Half of that client's inboxes sit for two
 * weeks (off live campaigns, warmup on). Rotating pool generics are not
 * in this loop. D198 — generics dedicated to a named client rest here
 * with that client's pods (own A/B split).
 *
 * D207 — off-week detach is ACTIVE only. PAUSED/STOPPED campaigns keep
 * their senders (Peterson #3798229 lost 37 of 40 seats after bounce
 * auto-pause when D169 hygiene ran). On-week restore for named seats
 * **and** that client's generics targets every ACTIVE client campaign
 * (D59/D207). Same-client generic multi-link is required; exclusive
 * attach / paused-detach hygiene peel are retired. Excluded / canary
 * / pod-control shells stay untouched.
 *
 * D154 — on-week restore must not re-staff inboxes that still owe warmup.
 * Health runs client-rest *before* the warmup gate every pass; without this
 * check, under-warmed Parlay/Culturefits boxes were put back on every
 * ACTIVE client campaign each cycle (the D143 "boomerang"), then pulled
 * again — an in-app fight, not an outside sync.
 *
 * D189 retired by D229 — Insight campaigns rest like every other
 * named client. Off-week seats unlink from Insight; campaigns
 * keep only the on-week POD (D228). The D184/D192 mix still
 * holds: Insight staff never restore onto ACTIVE SalesGlider,
 * and ACTIVE SG staff never restore onto Insight.
 *
 * D330 — for each campaign, attach the on-week pod and confirm
 * those adds before any off-week detach. A budget stop or a 429
 * saves a cursor and resumes; it does not empty the campaign
 * first. The 15-minute stage ceiling stays (D317). While the
 * swap is unfinished, state.podSwap / GET /pod-swap say so.
 *
 * D197 / D199 / D207 / D209 / D228 — the on-week campaign floor
 * stays ≥40 *on-week* staffable senders. Off-week named (and
 * off-week assigned generics) unlink from those campaigns even
 * when total linked staffable is already 40 — the peel floor
 * does not protect leftover off-week seats, once the on-week
 * attach for that campaign is confirmed (D330). Raw membership
 * leftovers do not count as surplus. A rest record on a
 * still-attached seat does not shrink the floor or exempt an
 * on-week peel (D209). Dedicated named-client generics rest
 * with this client's pods and fan out like named seats.
 * Same-client multi-link is not a peel reason. Off-week
 * assigned generics keep `client_id` + POD tag + signature
 * (inventory is 40/40). A generic never rotates PODs (D230).
 * PAUSED/STOPPED are never detached.
 */

/** Live-client statuses rest may detach from (D207). PAUSED/STOPPED keep seats. */
export const REST_DETACH_STATUSES = new Set(["ACTIVE"]);

/**
 * True when A/B rest may remove this membership. ACTIVE only (D207) —
 * a bounce auto-pause must not strip the on-week half. Shells and
 * TOP_UP_EXCLUDE_CAMPAIGNS stay out via `isExcluded`.
 */
export function isRestDetachableCampaign(
  campaign:
    | {
        id: number;
        name?: string | null;
        status?: string | null;
        client_id?: number | null;
      }
    | undefined,
  excluded: string[],
): boolean {
  if (!campaign) return false;
  const status = String(campaign.status ?? "").toUpperCase();
  if (!REST_DETACH_STATUSES.has(status)) return false;
  if (isExcluded(campaign, excluded)) return false;
  return true;
}

export interface ClientRestResult {
  dryRun: boolean;
  onWeekCohort: RestCohort;
  examined: number;
  benched: Array<{ email: string; campaignIds: number[] }>;
  restored: Array<{ email: string; campaignIds: number[] }>;
  skipped: string[];
  errors: string[];
  /** D330 — this pass stopped early; the next one resumes the cursor. */
  partial?: boolean;
}

/**
 * True only when every *known* campaign this inbox is on is excluded.
 * Unknown / leftover campaign ids do not count as excluded (D63) — those
 * inboxes still belong in the A/B rest loop.
 */
export function isExcludedOnlyMembership(
  campaignIds: number[],
  campaignById: Map<number, { id: number; name?: string | null }>,
  excluded: string[],
): boolean {
  const known = campaignIds
    .map((id) => campaignById.get(id))
    .filter((campaign): campaign is { id: number; name?: string | null } =>
      Boolean(campaign),
    )
    .filter((campaign) => !isAnyShellCampaign(campaign));
  return (
    known.length > 0 &&
    known.every((campaign) => isExcluded(campaign, excluded))
  );
}

type RestWork = {
  account: SmartleadAccountWithCampaigns;
  email: string;
  groupKey: string;
  cohort: RestCohort;
  existing: ReturnType<StateStore["getRestingInbox"]>;
  detachable: number[];
  alreadyOnActive: number[];
};

export function clientRestGroupKey(
  account: SmartleadAccountWithCampaigns,
  email: string,
  campaignClientById: Map<number, number | null | undefined>,
): string | null {
  if (isJeremyCiotolaSeat(account)) return `id:${CIOTOLA_CLIENT_ID}`;
  if (typeof account.client_id === "number" && Number.isFinite(account.client_id)) {
    return `id:${account.client_id}`;
  }
  for (const id of campaignIdsOf(account)) {
    const clientId = campaignClientById.get(id);
    if (typeof clientId === "number" && Number.isFinite(clientId)) {
      return `id:${clientId}`;
    }
  }
  const domain = email.split("@")[1] ?? "";
  if (isBcpOwnedDomain(domain)) return "bcp";
  return null;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError";
}

function linkAbort(
  parent: AbortSignal | undefined,
  child: AbortController,
): () => void {
  if (!parent) return () => undefined;
  if (parent.aborted) {
    child.abort();
    return () => undefined;
  }
  const onAbort = (): void => child.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

export class ClientRestService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: {
      dryRun?: boolean;
      now?: Date;
      inventory?: InventorySnapshot;
      joshLive?: boolean;
      /** D330 — stage abort. A budget stop returns; it does not throw. */
      signal?: AbortSignal;
      /** D330 — pass budget. Defaults to POD_SWAP_PASS_BUDGET_MS. */
      budgetMs?: number;
      /** D330 — test clock. Production uses Date.now. */
      monoNow?: () => number;
    } = {},
  ): Promise<ClientRestResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const now = opts.now ?? new Date();
    const result: ClientRestResult = {
      dryRun,
      onWeekCohort: onWeekCohort(now),
      examined: 0,
      benched: [],
      restored: [],
      skipped: [],
      errors: [],
    };

    if (!this.config.enableClientRest) {
      console.log("[client-rest] Disabled (ENABLE_CLIENT_REST=false)");
      return result;
    }

    const { campaigns, accounts, clients = [] } =
      opts.inventory ?? (await fetchInventory(this.smartlead));
    const genericOwnerId = pocClientId(
      clients,
      this.config.pocClientNamePatterns,
    );
    const pocSkipIds = pocEngagementClientIds(
      clients,
      this.config.pocClientNamePatterns,
      this.state.listEndedPocClientIds(),
    );

    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c]),
    );
    const campaignClientById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c.client_id]),
    );
    const classPolicy = callerFollowUpPolicyFromConfig(this.config);
    const activeByClient = new Map<number, SmartleadCampaign[]>();
    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      // D264 — Gabe Calls is not an on-week restore / multi-link target.
      if (callerFollowUpExemptFromSenderTopUp(campaign, classPolicy)) continue;
      const clientId = isCiotolaCampaign(campaign)
        ? CIOTOLA_CLIENT_ID
        : campaign.client_id;
      if (typeof clientId !== "number") continue;
      const list = activeByClient.get(clientId) ?? [];
      list.push(campaign);
      activeByClient.set(clientId, list);
    }

    const brandByClientId = new Map<number, string>();
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }
    const membership = countStaffableMemberships(
      accounts as SmartleadAccountWithCampaigns[],
      this.state,
    );

    const candidates: Array<{
      account: SmartleadAccountWithCampaigns;
      email: string;
      groupKey: string;
    }> = [];
    const byGroup = new Map<string, Array<{ email: string; type?: string | null }>>();
    const dedicatedByGroup = new Map<
      string,
      Array<{ email: string; type?: string | null }>
    >();

    let classified = 0;
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      classified += 1;
      if (classified % 16 === 0) {
        await yieldEventLoop();
        await pauseWhileOverdueCanonOps({ label: "health:client-rest" });
      }
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (isGabeVmReserved(account)) {
        result.skipped.push(`${email}: GABE-VM-RESERVED (D241)`);
        continue;
      }
      const domain = email.split("@")[1]?.toLowerCase();
      if (
        isRetiredSendingDomain(domain, this.state.getDomainHistory(domain))
      ) {
        result.skipped.push(`${email}: retired domain`);
        continue;
      }
      if (
        senderIsAttachBlocked(
          { email, accountId: account.id, domain },
          this.state,
        )
      ) {
        result.skipped.push(`${email}: attach blocked (D176)`);
        continue;
      }
      const dedicatedClientId = isGenericMailbox(
        account,
        email,
        this.config,
        this.state,
      )
        ? resolveDedicatedGenericClientId(
            account,
            email,
            campaignIdsOf(account).map((id) => {
              const campaign = campaignById.get(id);
              return {
                clientId:
                  typeof campaign?.client_id === "number"
                    ? campaign.client_id
                    : null,
                shell: campaign ? isAnyShellCampaign(campaign) : false,
              };
            }),
            this.state,
            { genericOwnerId, brandByClientId },
          )
        : null;
      // D43 — rotating pool generics stay on the send clock.
      // D198 — dedicated named-client generics rest with that client's
      // A/B pods (own split, so named-inbox cohorts do not flip).
      if (
        isGenericMailbox(account, email, this.config, this.state) &&
        dedicatedClientId == null
      ) {
        continue;
      }
      const groupKey =
        dedicatedClientId != null
          ? `id:${dedicatedClientId}`
          : clientRestGroupKey(account, email, campaignClientById);
      if (!groupKey) {
        result.skipped.push(`${email}: no client group`);
        continue;
      }
      const rotationClientId =
        dedicatedClientId ?? clientIdFromRestGroupKey(groupKey);
      if (isPodRotationSkippedClient(rotationClientId, pocSkipIds)) {
        result.skipped.push(
          `${email}: POD rotation skip client ${rotationClientId} (D223/D236)`,
        );
        continue;
      }
      const onCampaigns = campaignIdsOf(account);
      const onlyExcluded = isExcludedOnlyMembership(
        onCampaigns,
        campaignById,
        this.config.topUpExcludeCampaigns,
      );
      if (onlyExcluded) {
        result.skipped.push(`${email}: excluded campaign`);
        continue;
      }
      candidates.push({ account, email, groupKey });
      const target = dedicatedClientId != null ? dedicatedByGroup : byGroup;
      const list = target.get(groupKey) ?? [];
      list.push({ email, type: account.type });
      target.set(groupKey, list);
    }

    const cohortByEmail = new Map<string, RestCohort>();
    const applyCohorts = (
      inboxes: Array<{ email: string; type?: string | null }>,
      tagged: Map<string, RestCohort>,
    ): void => {
      // D230 — a tagged generic keeps its POD. Untagged dedicated
      // leftovers still take the static cut; that cut must not
      // overwrite a locked POD tag.
      const untagged = inboxes.filter((row) => !tagged.has(row.email));
      for (const [email, cohort] of tagged) {
        if (inboxes.some((row) => row.email === email)) {
          cohortByEmail.set(email, cohort);
        }
      }
      for (const [email, cohort] of assignClientCohorts(untagged)) {
        cohortByEmail.set(email, cohort);
      }
    };
    const taggedByEmail = new Map<string, RestCohort>();
    for (const { account, email } of candidates) {
      const pod = mailboxPodOf(account);
      if (pod) taggedByEmail.set(email, pod);
    }
    for (const [, inboxes] of byGroup) {
      applyCohorts(inboxes, taggedByEmail);
    }
    for (const [, inboxes] of dedicatedByGroup) {
      applyCohorts(inboxes, taggedByEmail);
    }

    const offWeek: RestWork[] = [];
    const onWeek: RestWork[] = [];

    for (const { account, email, groupKey } of candidates) {
      result.examined += 1;
      const cohort = cohortByEmail.get(email);
      if (!cohort) continue;

      if (activeHoldUntilDate(tagNames(account))) {
        result.skipped.push(`${email}: held`);
        continue;
      }

      const existing = this.state.getRestingInbox(email);
      // D198 — a dedicated seat that still has a send-clock rest
      // record moves onto client A/B; do not skip it as a rotating generic.
      if (existing?.kind === "generic") {
        const dedicated = resolveDedicatedGenericClientId(
          account,
          email,
          campaignIdsOf(account).map((id) => {
            const campaign = campaignById.get(id);
            return {
              clientId:
                typeof campaign?.client_id === "number"
                  ? campaign.client_id
                  : null,
              shell: campaign ? isAnyShellCampaign(campaign) : false,
            };
          }),
          this.state,
          { genericOwnerId, brandByClientId },
        );
        if (dedicated == null) continue;
        if (!dryRun) this.state.clearRestingInbox(email);
      }

      // D207 — detachable = ACTIVE only. PAUSED/STOPPED keep their senders.
      // D324 — CAYDEN-SG stays on Booking Follow Up through the off week.
      const detachable = campaignIdsOf(account).filter((id) => {
        const campaign = campaignById.get(id);
        if (
          !isRestDetachableCampaign(
            campaign,
            this.config.topUpExcludeCampaigns,
          )
        ) {
          return false;
        }
        return caydenSgRestMayDetach(account, campaign);
      });
      // ACTIVE memberships the box already has. Using detachable-only
      // here would re-POST every already-on attach every on-week pass.
      const alreadyOnActive = campaignIdsOf(account).filter((id) => {
        const campaign = campaignById.get(id);
        return String(campaign?.status ?? "").toUpperCase() === "ACTIVE";
      });
      const work: RestWork = {
        account,
        email,
        groupKey,
        cohort,
        existing,
        detachable,
        alreadyOnActive,
      };
      if (isOffWeek(cohort, now)) offWeek.push(work);
      else onWeek.push(work);
    }

    await this.swapPods({
      dryRun,
      now,
      result,
      offWeek,
      onWeek,
      membership,
      campaignById,
      campaigns: campaigns as SmartleadCampaign[],
      activeByClient,
      signal: opts.signal,
      budgetMs: opts.budgetMs,
      monoNow: opts.monoNow,
    });

    if (!dryRun) await this.state.save();

    console.log(
      `[client-rest] onWeek=${result.onWeekCohort} examined=${result.examined} benched=${result.benched.length} restored=${result.restored.length} errors=${result.errors.length}`,
    );

    // D71 — rest movements stay in the log. Slack does not say who is on
    // this fortnight.
    if (result.benched.length || result.restored.length) {
      console.log(
        `[client-rest] slack-quiet onWeek=${result.onWeekCohort} benched=${result.benched.length} restored=${result.restored.length}`,
      );
    }
    return result;
  }

  /**
   * D330 — per campaign, confirm on-week attaches before off-week
   * detaches. A budget stop or 429 leaves a cursor and does not
   * take seats off a campaign whose on-week pod is not confirmed.
   */
  private async swapPods(input: {
    dryRun: boolean;
    now: Date;
    result: ClientRestResult;
    offWeek: RestWork[];
    onWeek: RestWork[];
    membership: Map<number, number>;
    campaignById: Map<number, SmartleadCampaign>;
    campaigns: SmartleadCampaign[];
    activeByClient: Map<number, SmartleadCampaign[]>;
    signal?: AbortSignal;
    budgetMs?: number;
    monoNow?: () => number;
  }): Promise<void> {
    const {
      dryRun,
      now,
      result,
      offWeek,
      onWeek,
      membership,
      campaignById,
      campaigns,
      activeByClient,
    } = input;

    for (const row of offWeek) {
      if (row.detachable.length || row.existing) continue;
      if (!dryRun) {
        this.state.markRestingInbox({
          accountId: row.account.id,
          email: row.email,
          clientId: row.groupKey,
          cohort: row.cohort,
          kind: "client",
          restingSince: now.toISOString(),
          removedFromCampaigns: [],
          lastSameEspInbox: null,
        });
      }
    }

    const warmupSkipped = new Set<string>();
    const plannedAttaches: Array<{ row: RestWork; campaignId: number }> = [];
    for (const row of onWeek) {
      // D154 / D139 — under-warmed inboxes are not on-week staff.
      if (owesWarmup(row.account, row.email, this.config, this.state)) {
        result.skipped.push(`${row.email}: owes warmup (D139)`);
        warmupSkipped.add(row.email);
        continue;
      }
      const clientId =
        typeof row.account.client_id === "number" ? row.account.client_id : null;
      const parsedId = row.groupKey.startsWith("id:")
        ? Number(row.groupKey.slice(3))
        : clientId;
      const targets = this.onWeekTargets(
        Number.isFinite(parsedId) ? parsedId : null,
        row.groupKey,
        campaigns,
        activeByClient,
      );
      for (const campaignId of targets) {
        if (row.alreadyOnActive.includes(campaignId)) continue;
        plannedAttaches.push({ row, campaignId });
      }
    }
    const plannedDetaches: Array<{ row: RestWork; campaignId: number }> = [];
    for (const row of offWeek) {
      for (const campaignId of row.detachable) {
        plannedDetaches.push({ row, campaignId });
      }
    }
    plannedAttaches.sort(
      (a, b) => a.campaignId - b.campaignId || a.row.account.id - b.row.account.id,
    );
    plannedDetaches.sort(
      (a, b) => a.campaignId - b.campaignId || a.row.account.id - b.row.account.id,
    );

    const campaignIds = [
      ...new Set([
        ...plannedAttaches.map((plan) => plan.campaignId),
        ...plannedDetaches.map((plan) => plan.campaignId),
      ]),
    ].sort((a, b) => a - b);

    const live =
      !dryRun && typeof this.state.getPodSwap === "function";
    const stored = live ? this.state.getPodSwap() : null;
    let progress = podSwapForWeek(
      stored,
      isoWeekNumberNy(now),
      result.onWeekCohort,
      now.toISOString(),
    );
    if (!live) progress = freshPodSwap(progress.isoWeek, progress.onWeekCohort, progress.startedAt);

    const confirmed = new Set(progress.confirmedAttaches);
    const confirmedDetaches = new Set(progress.confirmedDetaches);
    const settled = new Set(progress.confirmedAttaches);
    const retry = new Set(progress.retryCampaignIds);
    const addedByEmail = new Map<string, number[]>();

    const budgetMs = input.budgetMs ?? POD_SWAP_PASS_BUDGET_MS;
    const mono = input.monoNow ?? (() => Date.now());
    const started = mono();
    const overBudget = (): boolean => mono() - started >= budgetMs;
    const budgetCtrl = new AbortController();
    const unlinkParent = linkAbort(input.signal, budgetCtrl);
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    if (!input.monoNow) {
      budgetTimer = setTimeout(() => budgetCtrl.abort(), budgetMs);
    }
    const signal = budgetCtrl.signal;

    const persist = (): void => {
      if (!live) return;
      this.state.setPodSwap(progress);
    };

    let stopped = false;
    let stoppedAt: number | null = null;

    const shouldStop = (): boolean =>
      overBudget() || signal.aborted || input.signal?.aborted === true;

    try {
      if (campaignIds.length && live) {
        progress = { ...progress, finishedAt: null, phase: "attach" };
        persist();
      }

      const workIds = campaignIds.filter(
        (id) =>
          progress.cursorCampaignId == null ||
          id >= progress.cursorCampaignId ||
          retry.has(id),
      );

      for (const campaignId of workIds) {
        if (shouldStop()) {
          stopped = true;
          stoppedAt = campaignId;
          break;
        }
        let blocked = false;
        const attaches = plannedAttaches.filter((plan) => plan.campaignId === campaignId);
        for (const plan of attaches) {
          if (shouldStop()) {
            stopped = true;
            stoppedAt = campaignId;
            break;
          }
          const key = podSwapAttachKey(campaignId, plan.row.account.id);
          if (confirmed.has(key)) {
            settled.add(key);
            continue;
          }
          const outcome = await this.tryAttachOnWeek(
            plan.row,
            campaignId,
            campaignById,
            membership,
            dryRun,
            result,
            signal,
          );
          if (outcome === "added") {
            confirmed.add(key);
            settled.add(key);
            const added = addedByEmail.get(plan.row.email) ?? [];
            added.push(campaignId);
            addedByEmail.set(plan.row.email, added);
          } else if (outcome === "skipped") {
            settled.add(key);
          } else if (outcome === "failed") {
            blocked = true;
          } else {
            stopped = true;
            stoppedAt = campaignId;
            break;
          }
        }
        if (stopped) break;
        if (blocked) {
          retry.add(campaignId);
          continue;
        }
        retry.delete(campaignId);
        const detaches = plannedDetaches.filter((plan) => plan.campaignId === campaignId);
        for (const plan of detaches) {
          if (shouldStop()) {
            stopped = true;
            stoppedAt = campaignId;
            break;
          }
          const key = podSwapDetachKey(campaignId, plan.row.account.id);
          if (confirmedDetaches.has(key)) continue;
          try {
            const removed = await this.detachFromCampaigns(
              plan.row.account,
              plan.row.email,
              [campaignId],
              membership,
              dryRun,
              result,
              campaignById,
              true,
              signal,
            );
            if (removed.includes(campaignId)) {
              confirmedDetaches.add(key);
              this.commitBench(plan.row, removed, dryRun, now, result);
            }
          } catch (error) {
            if (isAbortError(error) || isSmartleadRateLimit(error)) {
              stopped = true;
              stoppedAt = campaignId;
              break;
            }
            throw error;
          }
        }
        if (stopped) break;
      }
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      unlinkParent();
    }

    const outstanding = plannedAttaches.some((plan) => {
      const key = podSwapAttachKey(plan.campaignId, plan.row.account.id);
      return !settled.has(key);
    });
    const done =
      campaignIds.length === 0 ||
      (!stopped && retry.size === 0 && !outstanding);
    if (campaignIds.length || (live && stored && stored.phase !== "done")) {
      if (done) {
        progress = {
          ...progress,
          phase: "done",
          finishedAt: now.toISOString(),
          cursorCampaignId: null,
          retryCampaignIds: [],
          confirmedAttaches: [],
          confirmedDetaches: [],
        };
      } else if (campaignIds.length) {
        const resumeAt = [
          ...(stoppedAt != null ? [stoppedAt] : []),
          ...retry,
        ];
        progress = {
          ...progress,
          phase: outstanding ? "attach" : "detach",
          finishedAt: null,
          cursorCampaignId: resumeAt.length ? Math.min(...resumeAt) : null,
          retryCampaignIds: [...retry],
          confirmedAttaches: [...confirmed],
          confirmedDetaches: [...confirmedDetaches],
        };
      }
      persist();
    }
    result.partial = Boolean(campaignIds.length && !done);

    for (const row of onWeek) {
      if (warmupSkipped.has(row.email)) continue;
      const plans = plannedAttaches.filter((plan) => plan.row === row);
      const seatDone = plans.every((plan) =>
        settled.has(podSwapAttachKey(plan.campaignId, plan.row.account.id)),
      );
      if (!seatDone) continue;
      if (!dryRun) this.state.clearRestingInbox(row.email);
      const added = addedByEmail.get(row.email) ?? [];
      if (added.length || row.existing) {
        result.restored.push({ email: row.email, campaignIds: added });
      }
    }

    if (result.partial) {
      console.log(
        `[client-rest] swap partial — resume next pass onWeek=${result.onWeekCohort} cursor=${progress.cursorCampaignId ?? "none"}`,
      );
    }
  }

  private async tryAttachOnWeek(
    row: RestWork,
    campaignId: number,
    campaignById: Map<number, SmartleadCampaign>,
    membership: Map<number, number>,
    dryRun: boolean,
    result: ClientRestResult,
    signal: AbortSignal,
  ): Promise<"added" | "skipped" | "failed" | "stop"> {
    const target = campaignById.get(campaignId);
    if (
      target &&
      !canAttachMailboxToCampaign(row.account, target, campaignById, {
        insightRequiresExisting: true,
      })
    ) {
      result.skipped.push(
        `${row.email}: Insight / ACTIVE SalesGlider staffing split (D184)`,
      );
      return "skipped";
    }
    const classAttach = callerFollowUpMayAttach({
      email: row.email,
      account: row.account,
      campaign: target,
      warmed: !owesWarmup(row.account, row.email, this.config, this.state),
      policy: callerFollowUpPolicyFromConfig(this.config),
    });
    if (!classAttach.ok) {
      result.skipped.push(`${row.email}: ${classAttach.reason}`);
      return "skipped";
    }
    try {
      if (!dryRun) {
        await this.smartlead.addEmailAccountsToCampaign(
          campaignId,
          [row.account.id],
          { signal },
        );
        recordMembership(row.account, campaignId);
      }
      noteStaffableAttach(membership, campaignId, row.account, row.email, this.state);
      if (!row.alreadyOnActive.includes(campaignId)) {
        row.alreadyOnActive.push(campaignId);
      }
      if (!dryRun) {
        await sleep(150, signal).catch((error: unknown) => {
          if (!isAbortError(error)) throw error;
        });
      }
      return "added";
    } catch (error) {
      if (isAbortError(error)) return "stop";
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${row.email} restore #${campaignId}: ${message}`);
      if (isSmartleadRateLimit(error)) return "stop";
      return "failed";
    }
  }

  /**
   * D209 — only write a rest record after a successful detach, or
   * when the seat is already idle (nothing detachable). Marking a
   * floor-blocked still-attached seat as resting made the next
   * pass treat it as non-staffable and peel it below 40.
   */
  private commitBench(
    row: RestWork,
    removed: number[],
    dryRun: boolean,
    now: Date,
    result: ClientRestResult,
  ): void {
    if (!removed.length) return;
    const prior = result.benched.find((entry) => entry.email === row.email);
    if (prior) {
      for (const id of removed) {
        if (!prior.campaignIds.includes(id)) prior.campaignIds.push(id);
      }
    } else {
      result.benched.push({ email: row.email, campaignIds: [...removed] });
    }
    const merged = result.benched.find((entry) => entry.email === row.email);
    if (!dryRun) {
      this.state.markRestingInbox({
        accountId: row.account.id,
        email: row.email,
        clientId: row.groupKey,
        cohort: row.cohort,
        kind: "client",
        restingSince: row.existing?.restingSince ?? now.toISOString(),
        removedFromCampaigns: [
          ...new Set([
            ...(row.existing?.removedFromCampaigns ?? []),
            ...(merged?.campaignIds ?? removed),
          ]),
        ],
        lastSameEspInbox: row.existing?.lastSameEspInbox ?? null,
      });
    }
  }

  private onWeekTargets(
    clientId: number | null,
    groupKey: string,
    campaigns: SmartleadCampaign[],
    activeByClient: Map<number, SmartleadCampaign[]>,
  ): number[] {
    const fromClient =
      clientId != null ? (activeByClient.get(clientId) ?? []) : [];
    const fromBcp =
      groupKey === "bcp"
        ? campaigns.filter((campaign) => {
            if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") {
              return false;
            }
            if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) {
              return false;
            }
            return isBcpCampaignName(String(campaign.name ?? ""));
          })
        : [];
    return [...new Set([...fromClient, ...fromBcp].map((campaign) => campaign.id))];
  }

  /** Last-account-on-campaign guard applies to every detach (D43 / D207). */
  private async detachFromCampaigns(
    account: SmartleadAccountWithCampaigns,
    email: string,
    campaignIds: number[],
    membership: Map<number, number>,
    dryRun: boolean,
    result: ClientRestResult,
    campaignById: Map<number, SmartleadCampaign>,
    offWeekNamedUnlink = false,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const removed: number[] = [];
    for (const campaignId of campaignIds) {
      const remaining = membership.get(campaignId) ?? 0;
      if (
        detachWouldBreakStaffableFloor(
          campaignById.get(campaignId),
          remaining,
          account,
          email,
          this.state,
          { exempt: offWeekNamedUnlink },
        )
      ) {
        result.skipped.push(
          `${email}: #${campaignId} at per-campaign min ${ON_WEEK_MIN_SENDERS} (D207)`,
        );
        continue;
      }
      if (remaining <= 1) {
        result.skipped.push(
          `${email}: last account on #${campaignId} — wait for top-up`,
        );
        continue;
      }
      try {
        if (!dryRun) {
          await this.smartlead.removeEmailAccountsFromCampaign(
            campaignId,
            [account.id],
            { signal },
          );
          dropMembership(account, campaignId);
        }
        noteStaffableDetach(membership, campaignId, account, email, this.state);
        removed.push(campaignId);
        if (!dryRun) {
          await sleep(150, signal).catch((error: unknown) => {
            if (!isAbortError(error)) throw error;
          });
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        const message =
          error instanceof Error ? error.message : String(error);
        result.errors.push(`${email} remove #${campaignId}: ${message}`);
        if (isSmartleadRateLimit(error)) throw error;
      }
    }
    return removed;
  }
}
