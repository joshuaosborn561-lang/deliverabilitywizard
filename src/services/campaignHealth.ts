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
import { staffingSlackLines } from "../lib/staffingSlack.js";
import {
  CampaignTopUpService,
  isExcluded,
  type TopUpResult,
} from "./campaignTopUp.js";
import type { ClientFanOutService } from "./clientFanOut.js";
import type { CopyCanaryAttachResult, CopyCanaryService } from "./copyCanary.js";
import { fetchInventory, type InventorySnapshot } from "./inventory.js";

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

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot } = {},
  ): Promise<CampaignHealthResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CampaignHealthResult = {
      dryRun,
      // D58/D82/D128 — there is no global floor; per-campaign floors are half
      // that client's inboxes and live on each snapshot. 0 here means
      // "unknown until snapshotted", never a staffing target.
      floor: 0,
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
    let inventory = opts.inventory ?? null;
    try {
      inventory = inventory ?? (await fetchInventory(this.smartlead));
      campaigns = inventory.campaigns;
      accounts = inventory.accounts;
      clients = inventory.clients;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`inventory: ${message}`);
      this.state.setLastHealthAt(new Date().toISOString());
      await this.state.save();
      return result;
    }

    result.snapshots = this.buildSnapshots(campaigns, accounts, clients);

    try {
      result.topUp = await this.topUp.run({ dryRun, inventory: inventory ?? undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`top-up: ${message}`);
    }

    // D26: every mailbox for a client onto every ACTIVE campaign for that client.
    if (this.fanOut) {
      try {
        const fan = await this.fanOut.run({
          dryRun,
          inventory: inventory ?? undefined,
        });
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

    // Top-up and fan-out keep the shared snapshot truthful in place
    // (recordMembership), so resume decisions below reuse it instead of
    // re-fetching the whole account book a second time per pass.

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
    this.state.setLastStaffingShort(result.stillShort);
    for (const row of result.stillShort) {
      console.log(
        `[health] short #${row.campaignId} ${row.name} — staffable ${row.staffable} short ${row.shortBy} (fill from same-client / BCP-owned inboxes, not pool generics)`,
      );
    }

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
        const clientName =
          typeof c.client_id === "number"
            ? clients.find((row) => row.id === c.client_id)?.name
            : null;
        const floor = staffFloorForCampaign(
          c,
          clientInboxCounts,
          clientName,
        );
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
      // D128 — no snapshot means the pass could not compute this client's
      // half-inbox floor; skip rather than resume against a guessed number
      // (the old code fell back to the dead 50-sender floor here).
      if (!snap) {
        console.log(
          `[health] Pending-resume #${pending.campaignId} ${name}: no staffing snapshot this pass — not resuming`,
        );
        continue;
      }
      if (staffable < snap.floor) continue;
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

    const action =
      assigned ||
      result.resumed.length ||
      (topUp?.released.length ?? 0) ||
      (topUp?.pulledGenerics.length ?? 0);
    // D64 — "still short" waits for the end-of-day brief. Health only
    // Slacks when it actually moved something.
    if (!action) return;

    const lines = staffingSlackLines({
      dryRun: result.dryRun,
      assigned: topUp?.assigned,
      resumed: result.resumed,
      stillShort: [],
      pulledGenerics: topUp?.pulledGenerics.length ?? 0,
      released: topUp?.released.length ?? 0,
    });

    // D71 — staffing movements stay in the log. Slack is not a restaff ticker.
    console.log(`[health] slack-quiet ${lines.join(" / ")}`);
  }
}
