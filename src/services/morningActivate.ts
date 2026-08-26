import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { clientDisplayName } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import { isOldClientCampaign } from "./oldClientTeardown.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import type { SmartleadClientRecord } from "../clients/smartlead.js";
import type { InventorySnapshot } from "./inventory.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 400;

export interface MorningActivateResult {
  dryRun: boolean;
  skipped: boolean;
  started: Array<{ campaignId: number; name: string }>;
  alreadyActive: number;
  blocked: string[];
  errors: string[];
}

/**
 * D109 — Josh: START Goliath, BCP, Peterson, Parlay, TechEvo for the
 * morning send. Shells stay paused. Old-client leftovers stay down.
 * One-shot; the 85% launch bar does not block this pass.
 */
export class MorningActivateService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot } = {},
  ): Promise<MorningActivateResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: MorningActivateResult = {
      dryRun,
      skipped: false,
      started: [],
      alreadyActive: 0,
      blocked: [],
      errors: [],
    };
    if (this.state.getMorningActivateAt()) {
      result.skipped = true;
      return result;
    }

    const campaigns =
      opts.inventory?.campaigns ?? (await this.smartlead.listCampaigns());
    const clients: SmartleadClientRecord[] =
      opts.inventory?.clients ??
      ((await this.smartlead.listClients().catch(() => [])) as SmartleadClientRecord[]);

    for (const campaign of campaigns as SmartleadCampaign[]) {
      const name = String(campaign.name ?? campaign.id);
      const clientName = clientDisplayName(
        clients.find((client) => client.id === campaign.client_id),
      );
      if (!matchesMorningBook(`${name} ${clientName}`, this.config.morningActivatePatterns)) {
        continue;
      }
      if (isPodControlShellCampaign(campaign)) {
        result.blocked.push(`#${campaign.id} ${name}: shell stays paused`);
        continue;
      }
      if (isOldClientCampaign(campaign, this.config.oldClientCampaignIds)) {
        result.blocked.push(`#${campaign.id} ${name}: old client`);
        continue;
      }
      const status = String(campaign.status ?? "").toUpperCase();
      if (status === "ACTIVE") {
        result.alreadyActive += 1;
        continue;
      }
      try {
        if (!dryRun) {
          await this.smartlead.updateCampaignStatus(campaign.id, "START");
          await sleep(WRITE_GAP_MS);
        }
        result.started.push({ campaignId: campaign.id, name });
        console.log(`[morning-activate] START #${campaign.id} ${name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id} ${name}: ${message}`);
      }
    }

    if (!dryRun) {
      this.state.setMorningActivateAt(new Date().toISOString());
      await this.state.save();
    }
    console.log(
      `[morning-activate] started=${result.started.length} already=${result.alreadyActive} blocked=${result.blocked.length}`,
    );
    return result;
  }
}

export function matchesMorningBook(hay: string, patterns: string[]): boolean {
  const text = hay.toLowerCase();
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    return Boolean(needle) && text.includes(needle);
  });
}
