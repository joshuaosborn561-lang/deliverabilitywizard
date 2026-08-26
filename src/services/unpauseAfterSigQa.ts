import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  normalizeTestList,
} from "../clients/smartdelivery.js";
import {
  brandFromClientDisplayName,
  clientBrandList,
  findForeignBrand,
} from "../lib/clientBrand.js";
import { isPocClient } from "../lib/pocClient.js";
import { isExcluded } from "./campaignTopUp.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { signatureHay } from "../lib/signatureQa.js";
import { sleep } from "../lib/http.js";
import type { SmartleadCampaign, SpamTestSummary } from "../types/index.js";
import type { StateStore } from "../state/store.js";
import { fetchInventory, type InventorySnapshot } from "./inventory.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 400;

export interface UnpauseAfterSigQaResult {
  dryRun: boolean;
  examined: number;
  started: Array<{ campaignId: number; name: string }>;
  blocked: string[];
  errors: string[];
}

/**
 * D106/D128 — the campaign's living placement reading must clear the launch
 * bar before auto-START. Promo tab counts as a miss (it is in the
 * denominator, not the numerator). No living reading → not proven → block.
 */
export function launchReadingPercent(
  tests: SpamTestSummary[],
  campaignId: number,
): number | null {
  const mine = tests
    .filter((test) => Number(campaignIdOf(test)) === campaignId)
    .sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    );
  for (const test of mine) {
    const inbox = Number(test.inbox_count ?? 0);
    const tab = Number(test.tab_count ?? 0);
    const spam = Number(test.spam_count ?? 0);
    const total = inbox + tab + spam;
    if (total > 0) return (inbox / total) * 100;
  }
  return null;
}

/**
 * D77 / D82 — after senders on a PAUSED **POC** campaign match that
 * campaign's assigned client, START it. Shell, STOPPED, DRAFTED, excluded,
 * and non-POC pauses stay down.
 *
 * D128 hardens two holes the audit found:
 * - never START a campaign the D90 bounce loop paused (the stamp clears
 *   only when a human STARTs it) — qa-unpause must not fight the pause;
 * - never START below the 85% launch bar (D106): the campaign's living
 *   placement test must read at or above `launchInboxThreshold`, and a
 *   campaign with no reading is not proven and stays down.
 */
export class UnpauseAfterSigQaService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot } = {},
  ): Promise<UnpauseAfterSigQaResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: UnpauseAfterSigQaResult = {
      dryRun,
      examined: 0,
      started: [],
      blocked: [],
      errors: [],
    };

    const { campaigns, accounts, clients } =
      opts.inventory ?? (await fetchInventory(this.smartlead));
    const brandByClientId = new Map<number, string>();
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }
    const allBrands = clientBrandList(clients);

    // Candidates that clear every cheap gate; the SmartDelivery read below
    // is spent only when at least one campaign is otherwise startable.
    const candidates: Array<{ campaign: SmartleadCampaign; name: string }> = [];

    for (const campaign of campaigns as SmartleadCampaign[]) {
      const status = String(campaign.status ?? "").toUpperCase();
      if (status !== "PAUSED") continue;
      result.examined += 1;
      const name = String(campaign.name ?? campaign.id);
      if (isAnyShellCampaign(campaign)) {
        result.blocked.push(`#${campaign.id} ${name}: shell stays paused`);
        continue;
      }
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) {
        result.blocked.push(`#${campaign.id} ${name}: excluded`);
        continue;
      }
      if (this.state.isBouncePaused(campaign.id)) {
        result.blocked.push(
          `#${campaign.id} ${name}: bounce loop paused this — a human STARTs it (D90)`,
        );
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
      candidates.push({ campaign, name });
    }

    if (!candidates.length) {
      console.log(
        `[qa-unpause] examined=${result.examined} started=0 blocked=${result.blocked.length}`,
      );
      return result;
    }

    let tests: SpamTestSummary[] | null = null;
    try {
      tests = normalizeTestList(await this.smartDelivery.listTests({}));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list tests: ${message}`);
    }

    for (const { campaign, name } of candidates) {
      if (!tests) {
        result.blocked.push(
          `#${campaign.id} ${name}: no placement reading (SmartDelivery list failed) — bar is ${this.config.launchInboxThreshold}% (D106)`,
        );
        continue;
      }
      const reading = launchReadingPercent(tests, campaign.id);
      if (reading == null) {
        result.blocked.push(
          `#${campaign.id} ${name}: no living placement reading — not proven at the ${this.config.launchInboxThreshold}% bar (D106)`,
        );
        continue;
      }
      if (reading < this.config.launchInboxThreshold) {
        result.blocked.push(
          `#${campaign.id} ${name}: ${reading.toFixed(0)}% inbox is below the ${this.config.launchInboxThreshold}% launch bar (D106)`,
        );
        continue;
      }

      try {
        if (!dryRun) {
          await this.smartlead.updateCampaignStatus(campaign.id, "START");
          await sleep(WRITE_GAP_MS);
        }
        result.started.push({ campaignId: campaign.id, name });
        console.log(
          `[qa-unpause] START #${campaign.id} ${name} — sigs match, ${reading.toFixed(0)}% ≥ ${this.config.launchInboxThreshold}%`,
        );
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
