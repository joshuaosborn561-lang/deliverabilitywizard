import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { desiredBounceAutopausePercent } from "../lib/bounceAutopause.js";
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
 * D78 — every campaign's Smartlead bounce auto-pause is 20% (Under-1k /
 * Goliath) or 7% (Over-1k and everyone else). Never 5%. Does not START
 * campaigns (D40 / D77 own resume).
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
      const desired = desiredBounceAutopausePercent(String(campaign.name ?? ""));
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
