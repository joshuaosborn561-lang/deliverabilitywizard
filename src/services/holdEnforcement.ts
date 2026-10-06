import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { chicagoWallClock } from "../lib/canonOpsHours.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import {
  callerFollowUpForbidsStatusWrite,
  callerFollowUpHumanActionAlert,
  callerFollowUpPolicyFromConfig,
} from "../lib/callerFollowUp.js";
import {
  campaignHoldReason,
  holdPolicyFromConfig,
} from "../lib/holdPolicy.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import { fetchInventory, type InventorySnapshot } from "./inventory.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 250;

export interface HoldEnforcementResult {
  dryRun: boolean;
  skipped?: boolean;
  reason?: string;
  examined: number;
  paused: Array<{ campaignId: number; name: string; reason: string }>;
  alreadyPaused: number;
  errors: string[];
}

/**
 * D205 — standing holds stay PAUSED. If one is found ACTIVE, pause it
 * and post one Slack line. Never STARTs. Bounce loop still never pauses
 * (D148); this is the hold list only.
 */
export class HoldEnforcementService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot; now?: Date } = {},
  ): Promise<HoldEnforcementResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: HoldEnforcementResult = {
      dryRun,
      examined: 0,
      paused: [],
      alreadyPaused: 0,
      errors: [],
    };
    if (!this.config.enableHoldEnforcement) {
      return { ...result, skipped: true, reason: "disabled" };
    }

    const policy = holdPolicyFromConfig(this.config);
    const todayYmd = chicagoWallClock(
      opts.now ?? new Date(),
      this.config.canonOpsTimezone,
    ).ymd;
    const { campaigns } = opts.inventory ?? (await fetchInventory(this.smartlead));

    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (isAnyShellCampaign(campaign)) continue;
      const reason = campaignHoldReason(campaign, policy, todayYmd);
      if (!reason) continue;
      result.examined += 1;
      const status = String(campaign.status ?? "").toUpperCase();
      const name = String(campaign.name ?? campaign.id);
      if (
        callerFollowUpForbidsStatusWrite(
          campaign,
          callerFollowUpPolicyFromConfig(this.config),
        )
      ) {
        if (status === "ACTIVE" || status === "START") {
          await this.slack.send(
            callerFollowUpHumanActionAlert({
              action: "pause",
              campaignId: campaign.id,
              campaignName: name,
              reason: `hold would PAUSE (${reason})`,
            }),
            undefined,
            "ops_alert",
          );
        }
        continue;
      }
      if (status !== "ACTIVE" && status !== "START") {
        result.alreadyPaused += 1;
        continue;
      }
      try {
        if (!dryRun) {
          await this.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
          await sleep(WRITE_GAP_MS);
        }
        result.paused.push({ campaignId: campaign.id, name, reason });
        console.log(
          `[hold-enforcement] PAUSED #${campaign.id} ${name} — ${reason}`,
        );
        await this.slack.send(
          `Paused *${name}* (#${campaign.id}) — ${reason}.`,
          undefined,
          "ops_alert",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id} ${name}: ${message}`);
      }
    }

    console.log(
      `[hold-enforcement] examined=${result.examined} paused=${result.paused.length} alreadyHeld=${result.alreadyPaused} errors=${result.errors.length}`,
    );
    if (!dryRun) await this.state.save();
    return result;
  }
}
