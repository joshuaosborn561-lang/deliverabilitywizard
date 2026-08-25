import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { statsFromAnalytics, ymdUtc } from "../lib/campaignDayStats.js";
import {
  SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT,
  campaignBounceAutostopThreshold,
  shouldAutostopCampaignForBounce,
} from "../lib/campaignBounceAutostop.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import { sleep } from "../lib/http.js";
import type { SmartleadCampaign } from "../types/index.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 350;
const ANALYTICS_START = "2020-01-01";

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

function lifetimeStart(campaign: SmartleadCampaign): string {
  const created = campaign.created_at;
  if (!created) return ANALYTICS_START;
  const parsed = new Date(created);
  if (!Number.isFinite(parsed.getTime())) return ANALYTICS_START;
  return ymdUtc(parsed);
}

function mergeSendBounce(...payloads: unknown[]): {
  sent: number;
  bounceRate: number;
} {
  let best = { sent: 0, bounceRate: 0 };
  for (const payload of payloads) {
    const row = statsFromAnalytics(payload);
    if (row.sent > best.sent) {
      best = { sent: row.sent, bounceRate: row.bounceRate };
    }
  }
  return best;
}

/**
 * D80 — pause ACTIVE campaigns on our send-volume bounce bands.
 * Does not START anyone (D40). Does not record pendingResumes — a bounce
 * pause stays paused until a human starts it. After a successful scan,
 * Smartlead bounce_autopause_threshold is converged to 100 (off).
 */
export class CampaignBounceAutostopService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
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

    const end = ymdUtc(new Date());
    const active = campaigns.filter((campaign) => {
      if (isPodControlShellCampaign(campaign, this.config.podControlShellCampaignId)) {
        return false;
      }
      return String(campaign.status ?? "").toUpperCase() === "ACTIVE";
    });

    for (const campaign of active) {
      result.scanned += 1;
      try {
        const [analytics, statistics] = await Promise.all([
          this.smartlead
            .getCampaignAnalyticsByDate(
              campaign.id,
              lifetimeStart(campaign),
              end,
            )
            .catch(() => null),
          this.smartlead.getCampaignStatistics(campaign.id).catch(() => null),
        ]);
        const bands = {
          minSent: this.config.bounceAutostopMinSent,
          highVolumeSent: this.config.bounceAutostopHighVolumeSent,
          midPercent: this.config.bounceAutostopMidPercent,
          highPercent: this.config.bounceAutostopHighPercent,
        };
        const { sent, bounceRate } = mergeSendBounce(analytics, statistics);
        const threshold = campaignBounceAutostopThreshold(sent, bands);
        if (threshold == null) {
          result.skipped += 1;
          console.log(
            `[bounce-autostop] skip #${campaign.id} ${campaign.name} sent=${sent} (need ${this.config.bounceAutostopMinSent})`,
          );
          continue;
        }
        if (!shouldAutostopCampaignForBounce(sent, bounceRate, bands)) {
          result.skipped += 1;
          continue;
        }

        const finding: BounceAutostopPause = {
          campaignId: campaign.id,
          campaignName: String(campaign.name ?? campaign.id),
          sent,
          bounceRate,
          threshold,
        };
        console.log(
          `[bounce-autostop] PAUSE #${finding.campaignId} ${finding.campaignName} sent=${sent} bounce=${bounceRate.toFixed(2)}% threshold=${threshold}%${dryRun ? " (dry-run)" : ""}`,
        );
        if (!dryRun) {
          await this.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
        }
        result.paused.push(finding);
        await sleep(WRITE_GAP_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id}: ${message}`);
      }
    }

    if (this.config.enableBounceAutopauseConverge) {
      await this.disableSmartleadAutopause(campaigns, dryRun, result);
    }

    console.log(
      `[bounce-autostop] scanned=${result.scanned} paused=${result.paused.length} skipped=${result.skipped} smartleadOff=${result.smartleadDisabled} errors=${result.errors.length}`,
    );
    return result;
  }

  private async disableSmartleadAutopause(
    campaigns: SmartleadCampaign[],
    dryRun: boolean,
    result: CampaignBounceAutostopResult,
  ): Promise<void> {
    const off = String(
      this.config.smartleadBounceAutopauseOffPercent ??
        SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT,
    );
    for (const campaign of campaigns) {
      if (isPodControlShellCampaign(campaign, this.config.podControlShellCampaignId)) {
        continue;
      }
      try {
        console.log(
          `[bounce-autostop] Smartlead autopause off ${campaign.name} #${campaign.id} → ${off}%${dryRun ? " (dry-run)" : ""}`,
        );
        if (!dryRun) {
          await this.smartlead.updateCampaignSettings(campaign.id, {
            bounce_autopause_threshold: off,
          });
          await sleep(WRITE_GAP_MS);
        }
        result.smartleadDisabled += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`disable #${campaign.id}: ${message}`);
      }
    }
  }
}
