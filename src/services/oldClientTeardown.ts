import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 400;

export interface OldClientTeardownResult {
  dryRun: boolean;
  skipped: boolean;
  deleted: Array<{ campaignId: number; name: string }>;
  errors: string[];
}

/**
 * D107 — Josh: delete the leftover old-client campaigns (Nieto, MSRS2,
 * Positive) so they leave the canon board.
 */
export class OldClientTeardownService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; campaigns?: SmartleadCampaign[] } = {},
  ): Promise<OldClientTeardownResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: OldClientTeardownResult = {
      dryRun,
      skipped: false,
      deleted: [],
      errors: [],
    };
    if (this.state.getOldClientTeardownAt()) {
      result.skipped = true;
      return result;
    }

    const campaigns =
      opts.campaigns ?? (await this.smartlead.listCampaigns());
    const targets = campaigns.filter((campaign) =>
      isOldClientCampaign(campaign, this.config.oldClientCampaignIds),
    );
    for (const campaign of targets) {
      const name = String(campaign.name ?? campaign.id);
      if (isPodControlShellCampaign(campaign)) continue;
      try {
        if (!dryRun) {
          await this.smartlead.deleteCampaign(campaign.id);
          await sleep(WRITE_GAP_MS);
        }
        result.deleted.push({ campaignId: campaign.id, name });
        console.log(`[old-client] deleted #${campaign.id} ${name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          if (!dryRun) {
            await this.smartlead.updateCampaignStatus(campaign.id, "STOPPED");
          }
          result.errors.push(`#${campaign.id} ${name}: delete failed (${message}); STOPPED`);
        } catch (stopError) {
          const stopMessage =
            stopError instanceof Error ? stopError.message : String(stopError);
          result.errors.push(
            `#${campaign.id} ${name}: delete ${message}; stop ${stopMessage}`,
          );
        }
      }
    }

    if (!dryRun) {
      this.state.setOldClientTeardownAt(new Date().toISOString());
      await this.state.save();
    }
    console.log(
      `[old-client] deleted=${result.deleted.length} errors=${result.errors.length}`,
    );
    return result;
  }
}

export function isOldClientCampaign(
  campaign: Pick<SmartleadCampaign, "id" | "name">,
  ids: number[],
): boolean {
  if (ids.includes(campaign.id)) return true;
  const hay = String(campaign.name ?? "").toLowerCase();
  return /\b(nieto|msrs2?|positive)\b/.test(hay);
}
