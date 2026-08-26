import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT } from "../lib/campaignBounceAutostop.js";
import { readBounceAutopausePercent } from "../lib/bounceAutopause.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 350;
/** Read-verify the off threshold this often; the 10m loop only fills gaps. */
const AUTOPAUSE_VERIFY_EVERY_MS = 6 * 60 * 60 * 1000;

/** COMPLETED / STOPPED campaigns never send again — stop touching them. */
export function isTerminalCampaignStatus(status: unknown): boolean {
  const s = String(status ?? "").toUpperCase();
  return s === "COMPLETED" || s === "STOPPED";
}

export interface BounceAutostopPause {
  campaignId: number;
  campaignName: string;
  sent: number;
  bounceRate: number;
  threshold: number;
}

export interface CampaignBounceAutostopResult {
  dryRun: boolean;
  scanned: number;
  paused: BounceAutostopPause[];
  skipped: number;
  smartleadDisabled: number;
  errors: string[];
}

/**
 * D80 / D88 — keep Smartlead bounce_autopause_threshold at 100 (off).
 * Does not START anyone (D40). Does not pause anyone on a bounce band
 * (D88 retired 20%/7%). D29 still investigates an already-PAUSED campaign.
 */
export class CampaignBounceAutostopService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state?: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<CampaignBounceAutostopResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CampaignBounceAutostopResult = {
      dryRun,
      scanned: 0,
      paused: [],
      skipped: 0,
      smartleadDisabled: 0,
      errors: [],
    };
    if (!this.config.enableCampaignBounceAutostop) {
      console.log("[bounce-autostop] Disabled");
      return result;
    }

    let campaigns: SmartleadCampaign[];
    try {
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list campaigns: ${message}`);
      return result;
    }

    // D88 — the 20%/7% campaign pause bands are retired. This loop only
    // keeps Smartlead bounce_autopause_threshold at 100 (off). D29 still
    // investigates an already-PAUSED campaign over 7%.
    result.scanned = campaigns.filter(
      (campaign) =>
        !isPodControlShellCampaign(
          campaign,
          this.config.podControlShellCampaignId,
        ) &&
        !isTerminalCampaignStatus(campaign.status) &&
        String(campaign.status ?? "").toUpperCase() === "ACTIVE",
    ).length;

    if (this.config.enableBounceAutopauseConverge) {
      await this.disableSmartleadAutopause(campaigns, dryRun, result);
    }

    console.log(
      `[bounce-autostop] scanned=${result.scanned} paused=0 (D88 bands retired) skipped=${result.skipped} smartleadOff=${result.smartleadDisabled} errors=${result.errors.length}`,
    );
    return result;
  }

  /**
   * D84 — converge on drift, not on schedule. The 10-minute loop writes only
   * campaigns we have never converged (new ids). Every 6h one read-verify
   * sweep checks living campaigns and rewrites only actual drift, so a
   * UI-side change still gets caught without ~600 blind writes/hour.
   */
  private async disableSmartleadAutopause(
    campaigns: SmartleadCampaign[],
    dryRun: boolean,
    result: CampaignBounceAutostopResult,
  ): Promise<void> {
    const off = String(
      this.config.smartleadBounceAutopauseOffPercent ??
        SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT,
    );
    const offNumber = Number(off);
    const living = campaigns.filter(
      (campaign) =>
        !isPodControlShellCampaign(campaign, this.config.podControlShellCampaignId) &&
        !isTerminalCampaignStatus(campaign.status),
    );

    const lastVerify = this.state?.getLastAutopauseVerifyAt();
    const verifyDue =
      !lastVerify ||
      Date.now() - Date.parse(lastVerify) >= AUTOPAUSE_VERIFY_EVERY_MS;

    for (const campaign of living) {
      const alreadyOff = this.state?.getAutopauseOffAt(campaign.id);
      if (alreadyOff && !verifyDue) continue;
      try {
        if (alreadyOff && verifyDue) {
          // Read-verify: rewrite only when Smartlead shows drift.
          const settings = await this.smartlead
            .getCampaignSettings(campaign.id)
            .catch(() => null);
          await sleep(120);
          const current = readBounceAutopausePercent(settings);
          if (current == null || current === offNumber) continue;
          console.log(
            `[bounce-autostop] drift on #${campaign.id} ${campaign.name}: autopause ${current}% → ${off}%${dryRun ? " (dry-run)" : ""}`,
          );
        } else {
          console.log(
            `[bounce-autostop] Smartlead autopause off ${campaign.name} #${campaign.id} → ${off}%${dryRun ? " (dry-run)" : ""}`,
          );
        }
        if (!dryRun) {
          await this.smartlead.updateCampaignSettings(campaign.id, {
            bounce_autopause_threshold: off,
          });
          await sleep(WRITE_GAP_MS);
          this.state?.markAutopauseOff(campaign.id);
        }
        result.smartleadDisabled += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`disable #${campaign.id}: ${message}`);
      }
    }

    if (verifyDue && !dryRun) {
      this.state?.setLastAutopauseVerifyAt(new Date().toISOString());
    }
  }
}
