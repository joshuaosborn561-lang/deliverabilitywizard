import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { type SmartleadClientRecord } from "../clients/smartlead.js";
import { matchClientForCampaign } from "../lib/campaignClient.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { sleep } from "../lib/http.js";
import {
  INSIGHT_CLIENT_ID,
  isInsightCampaignId,
} from "../lib/insightCampaigns.js";
import type { SmartleadCampaign } from "../types/index.js";
import type { InventorySnapshot } from "./inventory.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 250;

export interface CampaignClientTagResult {
  dryRun: boolean;
  examined: number;
  assigned: Array<{ campaignId: number; name: string; clientId: number }>;
  skipped: string[];
  errors: string[];
}

/**
 * D77 — every campaign carries an assigned Smartlead client so signature
 * QA can match senders to that client without guessing from the name.
 */
export class CampaignClientTagService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
  ) {}

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot } = {},
  ): Promise<CampaignClientTagResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CampaignClientTagResult = {
      dryRun,
      examined: 0,
      assigned: [],
      skipped: [],
      errors: [],
    };

    const campaigns =
      opts.inventory?.campaigns ??
      ((await this.smartlead.listCampaigns()) as SmartleadCampaign[]);
    const clients =
      opts.inventory?.clients ??
      (await this.smartlead
        .listClients()
        .catch(() => [] as SmartleadClientRecord[]));

    for (const campaign of campaigns as SmartleadCampaign[]) {
      result.examined += 1;
      if (isAnyShellCampaign(campaign)) {
        result.skipped.push(`#${campaign.id} shell — no client tag`);
        continue;
      }
      // D192 — named Insight campaigns stay client 582890. Never
      // rewrite an existing tag (including never 582890 → 345263).
      if (isInsightCampaignId(campaign.id)) {
        if (campaign.client_id === INSIGHT_CLIENT_ID) continue;
        if (typeof campaign.client_id === "number") {
          result.skipped.push(
            `#${campaign.id} Insight — already tagged ${campaign.client_id}, never rewrite (D192)`,
          );
          continue;
        }
        try {
          if (!dryRun) {
            await this.smartlead.setCampaignClientId(
              campaign.id,
              INSIGHT_CLIENT_ID,
            );
            await sleep(WRITE_GAP_MS);
            campaign.client_id = INSIGHT_CLIENT_ID;
          }
          result.assigned.push({
            campaignId: campaign.id,
            name: String(campaign.name ?? campaign.id),
            clientId: INSIGHT_CLIENT_ID,
          });
          console.log(
            `[client-tag] #${campaign.id} ${campaign.name} → Insight ${INSIGHT_CLIENT_ID} (D192)`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`#${campaign.id} ${campaign.name}: ${message}`);
        }
        continue;
      }
      if (typeof campaign.client_id === "number") continue;
      const match = matchClientForCampaign(String(campaign.name ?? ""), clients);
      if (!match) {
        result.skipped.push(
          `#${campaign.id} ${campaign.name}: no unique client match`,
        );
        continue;
      }
      try {
        if (!dryRun) {
          await this.smartlead.setCampaignClientId(campaign.id, match.id);
          await sleep(WRITE_GAP_MS);
          // Later stages in the same pass share this snapshot object.
          campaign.client_id = match.id;
        }
        result.assigned.push({
          campaignId: campaign.id,
          name: String(campaign.name ?? campaign.id),
          clientId: match.id,
        });
        console.log(
          `[client-tag] #${campaign.id} ${campaign.name} → client ${match.id}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id} ${campaign.name}: ${message}`);
      }
    }

    console.log(
      `[client-tag] examined=${result.examined} assigned=${result.assigned.length} skipped=${result.skipped.length}`,
    );
    for (const line of result.skipped.slice(0, 12)) {
      console.log(`[client-tag] skip ${line}`);
    }
    return result;
  }
}
