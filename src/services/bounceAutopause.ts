import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { desiredBounceAutopausePercent } from "../lib/bounceAutopause.js";
import { isExcluded } from "./campaignTopUp.js";

/**
 * D67 — Hold Under-1k campaigns at Smartlead bounce auto-pause 20%.
 *
 * Everyone else is left alone (fleet default stays 7%). Does not START
 * paused campaigns (D40). D29's 7% investigate line is unchanged.
 */

export interface BounceAutopauseResult {
  dryRun: boolean;
  scanned: number;
  matched: number;
  updated: number;
  errors: string[];
}

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
      matched: 0,
      updated: 0,
      errors: [],
    };
    if (!this.config.enableBounceAutopauseConverge) {
      console.log("[bounce-autopause] Disabled (ENABLE_BOUNCE_AUTOPAUSE_CONVERGE=false)");
      return result;
    }

    const target = this.config.under1kBounceAutopausePercent;
    const campaigns = await this.smartlead.listCampaigns();
    result.scanned = campaigns.length;

    for (const campaign of campaigns) {
      const desired = desiredBounceAutopausePercent(campaign.name, target);
      if (desired == null) continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      result.matched += 1;

      try {
        // GET /campaigns/{id}/settings 404s. Campaign GET does not echo the
        // threshold. A threshold-only POST leaves tracking / OOO intact.
        const body = { bounce_autopause_threshold: String(desired) };
        console.log(
          `[bounce-autopause] ${campaign.name} #${campaign.id} → ${desired}%${dryRun ? " (dry-run)" : ""}`,
        );
        if (!dryRun) {
          await this.smartlead.updateCampaignSettings(campaign.id, body);
          await sleep(350);
        }
        result.updated += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${campaign.name} #${campaign.id}: ${message}`);
        console.warn(
          `[bounce-autopause] failed ${campaign.name} #${campaign.id}`,
          error,
        );
      }
    }

    console.log(
      `[bounce-autopause] scanned=${result.scanned} under1k=${result.matched} updated=${result.updated} errors=${result.errors.length}`,
    );
    return result;
  }
}
