import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isBcpCampaignName } from "../lib/bcp.js";
import { isStaffableSender } from "../lib/staffableSender.js";
import type { StateStore } from "../state/store.js";
import {
  CampaignTopUpService,
  isExcluded,
  type TopUpResult,
} from "./campaignTopUp.js";

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
  needed: number;
  pendingResume: boolean;
}

export interface CampaignHealthResult {
  dryRun: boolean;
  floor: number;
  snapshots: CampaignHealthSnapshot[];
  topUp: TopUpResult | null;
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
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<CampaignHealthResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const floor = this.config.minCampaignSenders;
    const result: CampaignHealthResult = {
      dryRun,
      floor,
      snapshots: [],
      topUp: null,
      resumed: [],
      stillShort: [],
      errors: [],
    };

    console.log(
      `[health] Starting campaign health (${dryRun ? "DRY RUN" : "LIVE"}, floor=${floor} staffable)`,
    );

    let campaigns: SmartleadCampaign[] = [];
    let accounts: SmartleadAccountWithCampaigns[] = [];
    try {
      [campaigns, accounts] = await Promise.all([
        this.smartlead.listCampaigns(),
        this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`inventory: ${message}`);
      this.state.setLastHealthAt(new Date().toISOString());
      await this.state.save();
      return result;
    }

    result.snapshots = this.buildSnapshots(campaigns, accounts, floor);

    try {
      result.topUp = await this.topUp.run({ dryRun });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`top-up: ${message}`);
    }

    // Re-read membership after top-up so resume decisions use live Smartlead.
    try {
      accounts = await this.smartlead.listAllEmailAccounts({
        fetchCampaigns: true,
      });
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`re-inventory: ${message}`);
    }

    result.snapshots = this.buildSnapshots(campaigns, accounts, floor);
    await this.resumeStaffed(result, campaigns, dryRun);

    const shortAfter = result.snapshots.filter(
      (s) =>
        (s.status === "ACTIVE" || s.pendingResume) &&
        s.needed > 0 &&
        !isExcluded(
          { id: s.campaignId, name: s.campaignName },
          this.config.topUpExcludeCampaigns,
        ) &&
        !isBcpCampaignName(s.campaignName),
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

    console.log(
      `[health] resumed=${result.resumed.length} stillShort=${result.stillShort.length} topUpAssigned=${result.topUp?.assigned.length ?? 0} errors=${result.errors.length}`,
    );

    await this.notify(result);
    return result;
  }

  private buildSnapshots(
    campaigns: SmartleadCampaign[],
    accounts: SmartleadAccountWithCampaigns[],
    floor: number,
  ): CampaignHealthSnapshot[] {
    const membership = new Map<number, number>();
    const staffable = new Map<number, number>();
    const threshold = this.config.remediationInboxThreshold;

    for (const account of accounts) {
      const email = accountEmail(account);
      if (!email) continue;
      const ids = campaignIdsOf(account);
      for (const id of ids) {
        membership.set(id, (membership.get(id) ?? 0) + 1);
      }
      const heldRow = this.state.getHeldInbox(email);
      if (
        !isStaffableSender(account, {
          held: Boolean(heldRow),
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
        return {
          campaignId: c.id,
          campaignName: String(c.name ?? c.id),
          status,
          membership: membership.get(c.id) ?? 0,
          staffable: staff,
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

      if (staffable < result.floor) continue;
      if (status === "ACTIVE") {
        // Already live — drop the stale resume marker.
        this.state.clearPendingResume(pending.campaignId);
        continue;
      }
      if (status !== "PAUSED") {
        // STOPPED / archived — do not fight the operator.
        this.state.clearPendingResume(pending.campaignId);
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
          `[health] Resumed #${pending.campaignId} ${name} (${staffable} staffable)`,
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
      !(topUp?.released.length ?? 0)
    ) {
      return;
    }

    const byCampaign = new Map<string, number>();
    for (const a of topUp?.assigned ?? []) {
      const key = `#${a.campaignId} ${a.campaignName}`;
      byCampaign.set(key, (byCampaign.get(key) ?? 0) + 1);
    }

    const lines = [
      `${result.dryRun ? "[DRY RUN] " : ""}Campaign health (floor ${result.floor} connected+inboxing):`,
    ];
    for (const [name, n] of byCampaign) {
      lines.push(`- ${name}: +${n} generic(s)`);
    }
    for (const r of result.resumed) {
      lines.push(
        `- #${r.campaignId} ${r.name}: resumed (${r.staffable} staffable)`,
      );
    }
    for (const u of result.stillShort) {
      lines.push(
        `- #${u.campaignId} ${u.name}: still short ${u.shortBy} staffable (${u.status}) — pool/reconnect could not close the gap`,
      );
    }
    if (topUp?.released.length) {
      lines.push(
        `- released ${topUp.released.length} duplicated generic(s) from misbranded campaigns`,
      );
    }

    try {
      await this.slack.send(lines.join("\n"));
    } catch (error) {
      console.warn("[health] Slack notify failed", error);
    }
  }
}
