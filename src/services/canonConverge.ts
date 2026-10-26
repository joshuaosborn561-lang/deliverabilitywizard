/**
 * D303 — LOCKED canon (Josh 2026-10-25): mailbox rest-then-burn, ESP
 * auto-rebalance, and Mon–Thu 8am–7pm ET send-window convergence.
 *
 * Writes go through the Smartlead client (mutation queue) and the
 * Generics Ledger only. Never STARTs or pauses a campaign. Never buys.
 */

import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
  type SmartleadClient,
} from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import type { AppConfig } from "../config.js";
import type { SmartleadCampaign } from "../types/index.js";
import type { StateStore } from "../state/store.js";
import {
  decideRest,
  markReturned,
  mailboxIsCause,
  restAlertText,
  restCoveringFor,
  restsDueBack,
  withCoveringGeneric,
  type MailboxRestRecord,
} from "../lib/mailboxRest.js";
import { isFreeWarmLedgerSeat, isInsightClientId } from "../lib/genericLedger.js";
import {
  canonSchedulePayload,
  readCampaignSchedule,
  scheduleOnCanon,
} from "../lib/sendWindow.js";
import { planEspRebalance, type PodSeat, type SpareSeat } from "../lib/espRebalance.js";
import { requestRetireMailbox } from "../lib/retireAsk.js";
import {
  callerFollowUpPolicyFromConfig,
  isCallerFollowUpCampaign,
} from "../lib/callerFollowUp.js";
import { isGabeFollowUpCampaign } from "../lib/pocClient.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { senderEspBucket } from "../lib/canonStaffable.js";
import { GENERIC_LEDGER_WARMUP_DAYS } from "../lib/genericLedger.js";

type Smartlead = Pick<
  SmartleadClient,
  | "addEmailAccountsToCampaign"
  | "removeEmailAccountsFromCampaign"
  | "getCampaign"
  | "updateCampaignSchedule"
>;

export interface CanonConvergeDeps {
  smartlead: Smartlead;
  state: StateStore;
  slack: Pick<SlackClient, "send" | "notifyIsolationAction">;
  config: Pick<AppConfig, "dryRun"> & Partial<AppConfig>;
  now?: () => Date;
}

function isActive(c: { status?: string | null }): boolean {
  const s = String(c.status ?? "").toUpperCase();
  return s === "ACTIVE" || s === "START";
}

export class CanonConvergeService {
  constructor(private readonly deps: CanonConvergeDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Free warm generic from the Generics Ledger, same ESP preferred. */
  private pickCoverGeneric(exclude: Set<string>): string | null {
    const now = this.now();
    const seat = this.deps.state
      .listGenericSeats()
      .find(
        (s) =>
          !exclude.has(s.email) &&
          s.warmupEnabled !== false &&
          isFreeWarmLedgerSeat(s, now) &&
          typeof s.slAccountId === "number",
      );
    return seat?.email ?? null;
  }

  /**
   * Isolation said INFRA. Rest (or burn) each mailbox whose same-ESP
   * placement is under 80%. Returns the decisions taken.
   */
  async onIsolationVerdict(input: {
    verdict: string;
    clientId: number;
    pod: "A" | "B";
    /** Campaign isolation ran on; always included in the pull. */
    campaignId?: number;
    accounts: SmartleadAccountWithCampaigns[];
    sameEspOf: (email: string) => { inboxRate?: number; scoredSameEsp?: boolean } | undefined;
  }): Promise<Array<{ email: string; action: string }>> {
    const out: Array<{ email: string; action: string }> = [];
    if (input.verdict !== "INFRA") return out;
    for (const account of input.accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email || typeof account.id !== "number") continue;
      const reading = input.sameEspOf(email);
      if (
        !mailboxIsCause({
          verdict: input.verdict,
          sameEspInbox: reading?.inboxRate,
          scoredSameEsp: reading?.scoredSameEsp,
        })
      ) {
        continue;
      }
      const decision = decideRest({
        email,
        accountId: account.id,
        clientId: input.clientId,
        pod: input.pod,
        sameEspInbox: reading!.inboxRate!,
        campaignIds: [
          ...new Set([
            ...campaignIdsOf(account),
            ...(typeof input.campaignId === "number" ? [input.campaignId] : []),
          ]),
        ],
        existing: this.deps.state.getMailboxRest(email),
        now: this.now(),
      });
      if (decision.action === "none") continue;
      out.push({ email, action: decision.action });
      if (this.deps.config.dryRun) continue;
      let record = decision.record;
      for (const cid of record.removedFromCampaigns) {
        await this.deps.smartlead.removeEmailAccountsFromCampaign(cid, [account.id]);
      }
      if (decision.action === "rest") {
        record = await this.coverSeat(record, account);
      } else {
        // Retire this one mailbox only — never its domain.
        await requestRetireMailbox({
          store: this.deps.state,
          slack: this.deps.slack,
          email,
          accountId: account.id,
          campaignIds: record.removedFromCampaigns,
          clientId: record.clientId,
          proof: record.burnReason ?? "burned",
        }).catch((error) =>
          console.warn(`[d303] retire request for ${email} failed`, error),
        );
      }
      this.deps.state.upsertMailboxRest(record);
      await this.deps.slack.send(restAlertText(decision.action === "rest" ? { action: "rest", record } : { action: "burn", record }));
    }
    return out;
  }

  /** A free warm generic covers the rested seat; ledger records it. */
  private async coverSeat(
    record: MailboxRestRecord,
    _account: SmartleadAccountWithCampaigns,
  ): Promise<MailboxRestRecord> {
    // LOCKED: Insight never receives generics.
    if (isInsightClientId(record.clientId)) return record;
    const covering = new Set(
      this.deps.state.listMailboxRests().map((r) => r.coveringGeneric ?? ""),
    );
    const generic = this.pickCoverGeneric(covering);
    if (!generic) return record;
    const seat = this.deps.state.getGenericSeat(generic);
    const assigned = this.deps.state.assignGenericFromTable({
      email: generic,
      clientId: record.clientId,
      pod: record.pod,
      reason: `D303 rest cover for ${record.email}`,
      campaignIds: record.removedFromCampaigns,
      coveringFor: [restCoveringFor(record)],
      now: this.now(),
    });
    if (!assigned.ok || typeof seat?.slAccountId !== "number") return record;
    for (const cid of record.removedFromCampaigns) {
      await this.deps.smartlead.addEmailAccountsToCampaign(cid, [seat.slAccountId]);
    }
    return withCoveringGeneric(record, generic);
  }

  /** After 14 days: mailbox back on, covering generic out (warm-swap style). */
  async returnDueRests(): Promise<string[]> {
    const due = restsDueBack(this.deps.state.listMailboxRests(), this.now());
    const back: string[] = [];
    for (const record of due) {
      if (this.deps.config.dryRun) {
        back.push(record.email);
        continue;
      }
      if (typeof record.accountId === "number") {
        for (const cid of record.removedFromCampaigns) {
          await this.deps.smartlead.addEmailAccountsToCampaign(cid, [record.accountId]);
        }
      }
      if (record.coveringGeneric) {
        const seat = this.deps.state.getGenericSeat(record.coveringGeneric);
        if (typeof seat?.slAccountId === "number") {
          for (const cid of record.removedFromCampaigns) {
            await this.deps.smartlead.removeEmailAccountsFromCampaign(cid, [seat.slAccountId]);
          }
        }
        this.deps.state.releaseGenericFromTable(record.coveringGeneric, {
          now: this.now(),
          reason: `D303 rest over for ${record.email}`,
        });
      }
      this.deps.state.upsertMailboxRest(markReturned(record, this.now()));
      back.push(record.email);
    }
    return back;
  }

  /** Converge every active campaign to Mon–Thu 8am–7pm ET. */
  async convergeSendWindows(campaigns: SmartleadCampaign[]): Promise<{
    changed: number[];
    skipped: number[];
  }> {
    const changed: number[] = [];
    const skipped: number[] = [];
    const caller = callerFollowUpPolicyFromConfig(this.deps.config as AppConfig);
    for (const campaign of campaigns.filter(isActive)) {
      // D242 caller follow-up keeps its own Mon–Fri Chicago window; shells
      // are instrumentation, not client sends.
      if (
        isAnyShellCampaign(campaign) ||
        isGabeFollowUpCampaign(campaign) ||
        isCallerFollowUpCampaign(campaign, caller)
      ) {
        continue;
      }
      const raw = await this.deps.smartlead.getCampaign(campaign.id);
      const schedule = readCampaignSchedule(raw);
      if (scheduleOnCanon(schedule)) continue;
      const payload = canonSchedulePayload(schedule);
      if (!payload) {
        skipped.push(campaign.id);
        continue;
      }
      if (!this.deps.config.dryRun) {
        await this.deps.smartlead.updateCampaignSchedule(campaign.id, payload);
      }
      changed.push(campaign.id);
    }
    return { changed, skipped };
  }

  /**
   * Rebalance one on-week POD to the client's Microsoft share. Swaps are
   * 1-for-1 so POD-40 never drops. Generics come from / go back to the
   * ledger only.
   */
  async rebalancePod(input: {
    clientId: number;
    pod: "A" | "B";
    microsoftShare: number | undefined;
    campaignIds: number[];
    /** Campaigns the outgoing seat is on; the incoming seat joins exactly those. */
    campaignsForSeat?: (email: string) => number[];
    podSeats: Array<PodSeat & { accountId: number }>;
    spares: Array<SpareSeat & { accountId: number }>;
  }): Promise<{ swaps: number; reason: string }> {
    const insight = isInsightClientId(input.clientId);
    const plan = planEspRebalance({
      clientId: input.clientId,
      insight,
      microsoftShare: input.microsoftShare,
      pod: input.podSeats,
      spares: input.spares,
    });
    if (this.deps.config.dryRun) return { swaps: plan.swaps.length, reason: plan.reason };
    for (const swap of plan.swaps) {
      const outId = (swap.out as PodSeat & { accountId: number }).accountId;
      const inId = (swap.in as SpareSeat & { accountId: number }).accountId;
      if (swap.in.generic) {
        const ok = this.deps.state.assignGenericFromTable({
          email: swap.in.email,
          clientId: input.clientId,
          pod: input.pod,
          reason: "D303 ESP rebalance",
          campaignIds: input.campaignIds,
          now: this.now(),
        });
        if (!ok.ok) continue;
      }
      const seatCampaigns = input.campaignsForSeat?.(swap.out.email) ?? input.campaignIds;
      for (const cid of seatCampaigns.length ? seatCampaigns : input.campaignIds) {
        await this.deps.smartlead.addEmailAccountsToCampaign(cid, [inId]);
        await this.deps.smartlead.removeEmailAccountsFromCampaign(cid, [outId]);
      }
      if (swap.out.generic) {
        this.deps.state.releaseGenericFromTable(swap.out.email, {
          now: this.now(),
          reason: "D303 ESP rebalance",
        });
      }
    }
    return { swaps: plan.swaps.length, reason: plan.reason };
  }

  /** clientId → last whole-POD rebalance (ms), so one pass per client per run. */
  private readonly rebalancedAt = new Map<number, number>();

  /**
   * D303 — rebalance the WHOLE on-week POD of the client whose campaign drew
   * an esp_mix finding: every seat on any of the client's ACTIVE client
   * campaigns (shells / caller follow-up excluded). Each swap is applied to
   * every campaign the outgoing seat is on, so POD-40 holds everywhere.
   * Spares: the client's warm branded seats on no campaign, then free warm
   * ledger generics.
   */
  async rebalanceFromCampaign(input: {
    campaign: SmartleadCampaign;
    pod: "A" | "B";
    microsoftShare: number | undefined;
    attached: SmartleadAccountWithCampaigns[];
    allAccounts: SmartleadAccountWithCampaigns[];
    campaigns?: SmartleadCampaign[];
  }): Promise<{ swaps: number; reason: string; campaigns?: number[] }> {
    const clientId = input.campaign.client_id;
    if (typeof clientId !== "number") return { swaps: 0, reason: "no client" };
    const nowMs = this.now().getTime();
    const last = this.rebalancedAt.get(clientId);
    if (last !== undefined && nowMs - last < 50 * 60 * 1000) {
      return { swaps: 0, reason: "POD already rebalanced this pass" };
    }
    this.rebalancedAt.set(clientId, nowMs);
    const caller = callerFollowUpPolicyFromConfig(this.deps.config as AppConfig);
    const podCampaigns = (input.campaigns ?? [input.campaign]).filter(
      (c) =>
        c.client_id === clientId &&
        isActive(c) &&
        !isAnyShellCampaign(c) &&
        !isGabeFollowUpCampaign(c) &&
        !isCallerFollowUpCampaign(c, caller),
    );
    if (!podCampaigns.some((c) => c.id === input.campaign.id)) podCampaigns.push(input.campaign);
    const podCampaignIds = new Set(podCampaigns.map((c) => c.id));

    const warmMs = GENERIC_LEDGER_WARMUP_DAYS * 86_400_000;
    const bucket = (a: SmartleadAccountWithCampaigns) => {
      const b = senderEspBucket(a);
      return b === "outlook" || b === "gmail" ? b : null;
    };
    const resting = new Set(
      this.deps.state
        .listMailboxRests()
        .filter((r) => r.status !== "returned")
        .map((r) => r.email),
    );
    const campaignsOfSeat = new Map<string, number[]>();
    const podSeats: Array<PodSeat & { accountId: number }> = [];
    const seen = new Set<string>();
    const consider = (a: SmartleadAccountWithCampaigns, extra: number[] = []) => {
      const email = accountEmail(a)?.toLowerCase();
      const esp = bucket(a);
      if (!email || !esp || typeof a.id !== "number") return;
      const onPod = [...new Set([...campaignIdsOf(a), ...extra])].filter((id) => podCampaignIds.has(id));
      if (!onPod.length) return;
      campaignsOfSeat.set(email, [...new Set([...(campaignsOfSeat.get(email) ?? []), ...onPod])]);
      if (seen.has(email)) return;
      seen.add(email);
      podSeats.push({ email, esp, generic: Boolean(this.deps.state.getGenericSeat(email)), accountId: a.id });
    };
    for (const a of input.attached) consider(a, [input.campaign.id]);
    for (const a of input.allAccounts) consider(a);

    const spares: Array<SpareSeat & { accountId: number }> = [];
    for (const a of input.allAccounts) {
      const email = accountEmail(a)?.toLowerCase();
      const esp = bucket(a);
      if (!email || !esp || typeof a.id !== "number" || seen.has(email) || resting.has(email)) continue;
      const seat = this.deps.state.getGenericSeat(email);
      if (seat) {
        if (!isFreeWarmLedgerSeat(seat, this.now()) || seat.warmupEnabled === false) continue;
        spares.push({ email, esp, generic: true, warm: true, clientId: null, accountId: a.id });
        continue;
      }
      if (a.client_id !== clientId || campaignIdsOf(a).length) continue;
      const created = a.created_at ? Date.parse(a.created_at) : NaN;
      const warm = Number.isFinite(created) && nowMs - created >= warmMs;
      spares.push({ email, esp, generic: false, warm, clientId, accountId: a.id });
    }
    const done = await this.rebalancePod({
      clientId,
      pod: input.pod,
      microsoftShare: input.microsoftShare,
      campaignIds: [...podCampaignIds],
      campaignsForSeat: (email) => campaignsOfSeat.get(email) ?? [],
      podSeats,
      spares,
    });
    return { ...done, campaigns: [...podCampaignIds] };
  }
}
