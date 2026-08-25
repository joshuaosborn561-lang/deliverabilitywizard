import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import {
  brandFromClientDisplayName,
  clientBrandList,
  findForeignBrand,
} from "../lib/clientBrand.js";
import { isPocClient } from "../lib/pocClient.js";
import { isExcluded } from "./campaignTopUp.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import { signatureHay } from "../lib/signatureQa.js";
import { sleep } from "../lib/http.js";
import type { SmartleadCampaign } from "../types/index.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 400;

export interface UnpauseAfterSigQaResult {
  dryRun: boolean;
  examined: number;
  started: Array<{ campaignId: number; name: string }>;
  blocked: string[];
  errors: string[];
}

/**
 * D77 / D82 — after senders on a PAUSED **POC** campaign match that
 * campaign's assigned client, START it. Shell, STOPPED, DRAFTED, excluded,
 * and non-POC pauses stay down. Goliath is the current POC, not a name gate.
 */
export class UnpauseAfterSigQaService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<UnpauseAfterSigQaResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: UnpauseAfterSigQaResult = {
      dryRun,
      examined: 0,
      started: [],
      blocked: [],
      errors: [],
    };

    const [campaigns, accounts, clients] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);
    const brandByClientId = new Map<number, string>();
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }
    const allBrands = clientBrandList(clients);

    for (const campaign of campaigns as SmartleadCampaign[]) {
      const status = String(campaign.status ?? "").toUpperCase();
      if (status !== "PAUSED") continue;
      result.examined += 1;
      const name = String(campaign.name ?? campaign.id);
      if (isPodControlShellCampaign(campaign)) {
        result.blocked.push(`#${campaign.id} ${name}: shell stays paused`);
        continue;
      }
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) {
        result.blocked.push(`#${campaign.id} ${name}: excluded`);
        continue;
      }
      if (typeof campaign.client_id !== "number") {
        result.blocked.push(`#${campaign.id} ${name}: no client tag`);
        continue;
      }
      const clientName = clientDisplayName(
        clients.find((client) => client.id === campaign.client_id),
      );
      if (!isPocClient(`${name} ${clientName}`, this.config.pocClientNamePatterns)) {
        result.blocked.push(`#${campaign.id} ${name}: not a POC campaign`);
        continue;
      }
      const expected = brandByClientId.get(campaign.client_id) ?? "";
      if (!expected) {
        result.blocked.push(`#${campaign.id} ${name}: unknown client brand`);
        continue;
      }

      const mismatches: string[] = [];
      for (const account of accounts as SmartleadAccountWithCampaigns[]) {
        if (!campaignIdsOf(account).includes(campaign.id)) continue;
        const email = accountEmail(account);
        if (!email) continue;
        const hay = signatureHay({
          fromName: account.from_name,
          signature: account.signature,
        });
        const foreign = findForeignBrand(hay, expected, allBrands);
        if (foreign) mismatches.push(`${email} carries ${foreign}`);
      }
      if (mismatches.length) {
        result.blocked.push(
          `#${campaign.id} ${name}: ${mismatches.length} sig mismatch — ${mismatches[0]}`,
        );
        continue;
      }

      try {
        if (!dryRun) {
          await this.smartlead.updateCampaignStatus(campaign.id, "START");
          await sleep(WRITE_GAP_MS);
        }
        result.started.push({ campaignId: campaign.id, name });
        console.log(`[qa-unpause] START #${campaign.id} ${name} — sigs match ${expected}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id} ${name}: ${message}`);
      }
    }

    console.log(
      `[qa-unpause] examined=${result.examined} started=${result.started.length} blocked=${result.blocked.length}`,
    );
    return result;
  }
}
