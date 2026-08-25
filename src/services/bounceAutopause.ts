import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import { sleep } from "../lib/http.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 350;

export interface BounceAutopauseResult {
  dryRun: boolean;
  scanned: number;
  updated: number;
  errors: string[];
}

/**
 * D80 — Smartlead bounce auto-pause stays off (100). Does not START
 * campaigns. Prefer CampaignBounceAutostopService, which pauses on our
 * bands then calls this converge so a 5/7/20 leftover cannot linger.
 */
export class BounceAutopauseService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<BounceAutopauseResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: BounceAutopauseResult = {
      dryRun,
      scanned: 0,
      updated: 0,
      errors: [],
    };

    const campaigns = await this.smartlead.listCampaigns();
    result.scanned = campaigns.length;

    for (const campaign of campaigns) {
      if (isPodControlShellCampaign(campaign)) continue;
      const desired = this.config.smartleadBounceAutopauseOffPercent;
      try {
        console.log(
          `[bounce-autopause] ${campaign.name} #${campaign.id} → ${desired}%${dryRun ? " (dry-run)" : ""}`,
        );
        if (!dryRun) {
          await this.smartlead.updateCampaignSettings(campaign.id, {
            bounce_autopause_threshold: String(desired),
          });
          await sleep(WRITE_GAP_MS);
        }
        result.updated += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${campaign.name} #${campaign.id}: ${message}`);
      }
    }

    console.log(
      `[bounce-autopause] scanned=${result.scanned} updated=${result.updated} errors=${result.errors.length}`,
    );
    return result;
  }
}
