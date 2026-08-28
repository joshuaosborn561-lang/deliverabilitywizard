import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { type SmartleadClientRecord } from "../clients/smartlead.js";
import {
  matchClientForCampaign,
  numericClientId,
  restoredClientBrand,
} from "../lib/campaignClient.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { sleep } from "../lib/http.js";
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
 * D144 restored-client names (Nieto / MSRS / Positive) get a client row
 * if Smartlead no longer has one, then the same unique-name write.
 */
export class CampaignClientTagService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: Pick<
      SmartleadClient,
      "listCampaigns" | "listClients" | "setCampaignClientId" | "ensureClient"
    >,
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
    const clients: SmartleadClientRecord[] = [
      ...((opts.inventory?.clients ??
        (await this.smartlead
          .listClients()
          .catch(() => [] as SmartleadClientRecord[]))) as SmartleadClientRecord[]),
    ];
    const ensured = new Map<string, number>();

    for (const campaign of campaigns as SmartleadCampaign[]) {
      result.examined += 1;
      if (isAnyShellCampaign(campaign)) {
        result.skipped.push(`#${campaign.id} shell — no client tag`);
        continue;
      }
      const existingId = numericClientId(campaign.client_id);
      if (existingId != null) {
        campaign.client_id = existingId;
        continue;
      }
      const name = String(campaign.name ?? "");
      let match = matchClientForCampaign(name, clients);
      if (!match) {
        const restored = restoredClientBrand(name);
        if (!restored) {
          result.skipped.push(
            `#${campaign.id} ${campaign.name}: no unique client match`,
          );
          continue;
        }
        try {
          match = await this.clientRowForRestored(
            restored,
            clients,
            ensured,
            dryRun,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`#${campaign.id} ${campaign.name}: ${message}`);
          continue;
        }
        if (!match) {
          result.skipped.push(
            `#${campaign.id} ${campaign.name}: would ensure ${restored.brand} (dry-run)`,
          );
          continue;
        }
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

  private async clientRowForRestored(
    restored: NonNullable<ReturnType<typeof restoredClientBrand>>,
    clients: SmartleadClientRecord[],
    ensured: Map<string, number>,
    dryRun: boolean,
  ): Promise<SmartleadClientRecord | null> {
    const cachedId = ensured.get(restored.brand);
    const existing =
      (cachedId != null ? clients.find((client) => client.id === cachedId) : undefined) ??
      matchClientForCampaign(restored.brand, clients) ??
      clients.find((client) => {
        const name = String(client.name ?? "").trim().toLowerCase();
        const logo = String(client.logo ?? "").trim().toLowerCase();
        const brand = restored.brand.toLowerCase();
        return name === brand || logo === brand;
      });
    if (existing) return existing;
    if (dryRun) return null;
    let id = cachedId;
    if (id == null) {
      id = await this.smartlead.ensureClient(restored.brand, restored.email);
      ensured.set(restored.brand, id);
    }
    const row: SmartleadClientRecord = {
      id,
      name: restored.brand,
      logo: restored.brand,
    };
    if (!clients.some((client) => client.id === id)) clients.push(row);
    return row;
  }
}
