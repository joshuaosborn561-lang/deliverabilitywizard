import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import {
  countClientInboxesByKey,
  staffFloorForCampaign,
} from "../lib/clientStaffFloor.js";
import { isStaffableSender } from "../lib/staffableSender.js";
import type { StateStore } from "../state/store.js";
import {
  CampaignTopUpService,
  isExcluded,
  type TopUpResult,
} from "./campaignTopUp.js";
import type { ClientFanOutService } from "./clientFanOut.js";
import type { CopyCanaryAttachResult, CopyCanaryService } from "./copyCanary.js";

/**
 * Sole mutator brain for campaign staffing (D25).
 *
 * Smartlead membership is truth; local state is a cache for holds, pending
 * resumes, and pool inventory. Each pass:
 *   1. Refill thin ACTIVE / pending-resume campaigns (staffable floor)
 *   2. START campaigns that were protectively paused once staffed
 *   3. Slack only when the system cannot close a shortfall
 */

export interface CampaignHealthSnapshot {
  campaignId: number;
  campaignName: string;
  status: string;
  membership: number;
  staffable: number;
  floor: number;
  needed: number;
  pendingResume: boolean;
}

export interface CampaignHealthResult {
  dryRun: boolean;
  floor: number;
  snapshots: CampaignHealthSnapshot[];
  topUp: TopUpResult | null;
  fanOutAttached: number;
  copyCanaryAttached: number;
  resumed: Array<{ campaignId: number; name: string; staffable: number }>;
  stillShort: Array<{
    campaignId: number;
    name: string;
    staffable: number;
    shortBy: number;
    status: string;
  }>;
  errors: string[];
}

export class CampaignHealthService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly topUp: CampaignTopUpService,
    private readonly fanOut?: ClientFanOutService,
    private readonly copyCanary?: CopyCanaryService,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<CampaignHealthResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CampaignHealthResult = {
      dryRun,
      floor: this.config.minCampaignSenders,
      snapshots: [],
      topUp: null,
      fanOutAttached: 0,
      copyCanaryAttached: 0,
      resumed: [],
      stillShort: [],
      errors: [],
    };

    console.log(
      `[health] Starting campaign health (${dryRun ? "DRY RUN" : "LIVE"}, D58 half-client-inbox floors; generics on Goliath only)`,
    );

    let campaigns: SmartleadCampaign[] = [];
    let accounts: SmartleadAccountWithCampaigns[] = [];
    let clients: SmartleadClientRecord[] = [];
    try {
      [campaigns, accounts, clients] = await Promise.all([
        this.smartlead.listCampaigns(),
        this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
        this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`inventory: ${message}`);
      this.state.setLastHealthAt(new Date().toISOString());
      await this.state.save();
      return result;
    }

    result.snapshots = this.buildSnapshots(campaigns, accounts, clients);

    try {
      result.topUp = await this.topUp.run({ dryRun });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`top-up: ${message}`);
    }

    // D26: every mailbox for a client onto every ACTIVE campaign for that client.
    if (this.fanOut) {
      try {
        const fan = await this.fanOut.run({ dryRun });
        result.fanOutAttached = fan.attached.length;
        result.errors.push(...fan.errors.slice(0, 20));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`fan-out: ${message}`);
      }
    }

    // D55: dedicated canaries send campaign copy in placement tests, off campaigns.
    if (this.copyCanary) {
      try {
        const canary: CopyCanaryAttachResult = await this.copyCanary.attach({
          dryRun,
        });
        result.copyCanaryAttached = canary.attached.length;
        result.errors.push(...canary.errors.slice(0, 20));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`copy-canary: ${message}`);
      }
    }

    // Re-read membership after top-up/fan-out so resume decisions use live Smartlead.
    try {
      accounts = await this.smartlead.listAllEmailAccounts({
        fetchCampaigns: true,
      });
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`re-inventory: ${message}`);
    }

    result.snapshots = this.buildSnapshots(campaigns, accounts, clients);
    await this.resumeStaffed(result, campaigns, dryRun);

    const shortAfter = result.snapshots.filter(
      (s) =>
        (s.status === "ACTIVE" || s.pendingResume) &&
        s.needed > 0 &&
        !isExcluded(
          { id: s.campaignId, name: s.campaignName },
          this.config.topUpExcludeCampaigns,
        ),
    );
    result.stillShort = shortAfter.map((s) => ({
      campaignId: s.campaignId,
      name: s.campaignName,
      staffable: s.staffable,
      shortBy: s.needed,
      status: s.status,
    }));

    this.state.setLastHealthAt(new Date().toISOString());
    if (!dryRun) await this.state.save();

    const activeSnaps = result.snapshots.filter((s) => s.status === "ACTIVE");
    const atFloor = activeSnaps.filter((s) => s.needed === 0).length;
    console.log(
      `[health] ACTIVE ${activeSnaps.length} campaign(s): ${atFloor} at floor, ${result.stillShort.length} short; resumed=${result.resumed.length} topUpAssigned=${result.topUp?.assigned.length ?? 0} errors=${result.errors.length}`,
    );
    for (const s of [...activeSnaps].sort((a, b) => b.needed - a.needed)) {
      console.log(
        `[health]   #${s.campaignId} ${s.campaignName} — staffable ${s.staffable}/${s.floor} (membership ${s.membership})${s.needed ? ` short ${s.needed}` : ""}${s.pendingResume ? " pending-resume" : ""}`,
      );
    }
    for (const s of result.snapshots.filter(
      (row) => row.pendingResume && row.status !== "ACTIVE",
    )) {
      console.log(
        `[health]   #${s.campaignId} ${s.campaignName} — PAUSED pending-resume staffable ${s.staffable}/${s.floor}`,
      );
    }

    await this.notify(result);
    return result;
  }

  private buildSnapshots(
    campaigns: SmartleadCampaign[],
    accounts: SmartleadAccountWithCampaigns[],
    clients: SmartleadClientRecord[],
  ): CampaignHealthSnapshot[] {
    const membership = new Map<number, number>();
    const staffable = new Map<number, number>();
    const threshold = this.config.remediationInboxThreshold;
    const clientInboxCounts = countClientInboxesByKey(
      accounts,
      campaigns,
      clients,
      this.config,
      this.state,
    );

    for (const account of accounts) {
      const email = accountEmail(account);
      if (!email) continue;
      const ids = campaignIdsOf(account);
      for (const id of ids) {
        membership.set(id, (membership.get(id) ?? 0) + 1);
      }
      const heldRow = this.state.getHeldInbox(email);
      const resting = Boolean(this.state.getRestingInbox(email));
      const copyCanary = this.state.isCopyCanary(email);
      if (
        !isStaffableSender(account, {
          held: Boolean(heldRow),
          resting,
          copyCanary,
          inboxRate: heldRow?.inboxRate,
          inboxThreshold: threshold,
        })
      ) {
        continue;
      }
      for (const id of ids) {
        staffable.set(id, (staffable.get(id) ?? 0) + 1);
      }
    }

    return campaigns
      .filter((c) => {
        const status = String(c.status ?? "").toUpperCase();
        return (
          status === "ACTIVE" ||
          status === "PAUSED" ||
          this.state.hasPendingResume(c.id)
        );
      })
      .map((c) => {
        const status = String(c.status ?? "").toUpperCase();
        const staff = staffable.get(c.id) ?? 0;
        const floor = staffFloorForCampaign(c, clientInboxCounts);
        return {
          campaignId: c.id,
          campaignName: String(c.name ?? c.id),
          status,
          membership: membership.get(c.id) ?? 0,
          staffable: staff,
          floor,
          needed: Math.max(0, floor - staff),
          pendingResume: this.state.hasPendingResume(c.id),
        };
      });
  }

  private async resumeStaffed(
    result: CampaignHealthResult,
    campaigns: SmartleadCampaign[],
    dryRun: boolean,
  ): Promise<void> {
    const byId = new Map(campaigns.map((c) => [c.id, c]));
    for (const pending of this.state.listPendingResumes()) {
      const snap = result.snapshots.find(
        (s) => s.campaignId === pending.campaignId,
      );
      const campaign = byId.get(pending.campaignId);
      const staffable = snap?.staffable ?? 0;
      const status = String(
        snap?.status ?? campaign?.status ?? "",
      ).toUpperCase();
      const name = String(
        snap?.campaignName ??
          pending.campaignName ??
          campaign?.name ??
          pending.campaignId,
      );

      if (isExcluded({ id: pending.campaignId, name }, this.config.topUpExcludeCampaigns)) {
        this.state.clearPendingResume(pending.campaignId);
        continue;
      }
      if (staffable < (snap?.floor ?? result.floor)) continue;
      if (status === "ACTIVE") {
        // Already live — drop the stale resume marker.
        this.state.clearPendingResume(pending.campaignId);
        continue;
      }
      // D40 — only PAUSED protective pauses may be STARTed. STOPPED (and any
      // other status) means the operator took over; never fight that.
      if (status !== "PAUSED") {
        this.state.clearPendingResume(pending.campaignId);
        console.log(
          `[health] Cleared pending-resume for #${pending.campaignId} ${name} — status is ${status || "(unknown)"}, not auto-resuming`,
        );
        continue;
      }

      try {
        if (!dryRun) {
          await this.smartlead.updateCampaignStatus(
            pending.campaignId,
            "START",
          );
        }
        this.state.clearPendingResume(pending.campaignId);
        result.resumed.push({
          campaignId: pending.campaignId,
          name,
          staffable,
        });
        console.log(
          `[health] Resumed #${pending.campaignId} ${name} (${staffable} staffable) — protective pause only`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`resume ${pending.campaignId}: ${message}`);
      }
    }
  }

  private async notify(result: CampaignHealthResult): Promise<void> {
    const topUp = result.topUp;
    const assigned = topUp?.assigned.length ?? 0;
    if (
      !assigned &&
      !result.resumed.length &&
      !result.stillShort.length &&
      !(topUp?.released.length ?? 0) &&
      !(topUp?.pulledGenerics.length ?? 0)
    ) {
      return;
    }

    const byCampaign = new Map<string, number>();
    for (const a of topUp?.assigned ?? []) {
      const key = `#${a.campaignId} ${a.campaignName}`;
      byCampaign.set(key, (byCampaign.get(key) ?? 0) + 1);
    }

    const lines = [
      `${result.dryRun ? "Preview — " : ""}Campaign staffing`,
      "Each client's floor is half its own inboxes. Spare inboxes stay on Goliath only.",
    ];
    for (const [name, n] of byCampaign) {
      lines.push(`• ${name} — added ${n} spare${n === 1 ? "" : "s"}`);
    }
    for (const r of result.resumed) {
      lines.push(
        `• ${r.name} — turned back on (${r.staffable} sending inboxes). This was a pause we took to protect it, not a pause someone made by hand.`,
      );
    }
    for (const u of result.stillShort) {
      lines.push(
        `• ${u.name} — still short ${u.shortBy} sending inbox${u.shortBy === 1 ? "" : "es"} (${u.status}). Not enough warmed spares yet.`,
      );
    }
    if (topUp?.pulledGenerics.length) {
      lines.push(
        `Took ${topUp.pulledGenerics.length} spare membership${topUp.pulledGenerics.length === 1 ? "" : "s"} off every campaign that is not Goliath.`,
      );
    }
    if (topUp?.released.length) {
      lines.push(
        `Took ${topUp.released.length} spare${topUp.released.length === 1 ? "" : "s"} off campaigns they didn’t belong on.`,
      );
    }

    try {
      await this.slack.send(lines.join("\n"));
    } catch (error) {
      console.warn("[health] Slack notify failed", error);
    }
  }
}
