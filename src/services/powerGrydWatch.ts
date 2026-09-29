import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { POWERGRYD_CLIENT_ID } from "../lib/autoAllowGenerics.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { clientDisplayName } from "../clients/smartlead.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { resolveDedicatedGenericClientId } from "../lib/dedicatedGeneric.js";
import { pocClientId } from "../lib/pocClient.js";
import type { StateStore } from "../state/store.js";
import { fetchInventory, type InventorySnapshot } from "./inventory.js";

export interface PowerGrydWatchResult {
  dryRun: boolean;
  skipped?: boolean;
  reason?: string;
  clientId: number;
  target: number;
  dedicatedSeats: number;
  previous: number | null;
  alerted: boolean;
}

export function isPowerGrydClientId(
  id: number | null | undefined,
  configured = POWERGRYD_CLIENT_ID,
): boolean {
  return id === configured;
}

/**
 * Dedicated PowerGRYD seats: mailbox client_id or dedicated-generic
 * marks pointing at 592842. Alert-only — never peel / restaff / START.
 */
export function countPowerGrydDedicatedSeats(input: {
  accounts: SmartleadAccountWithCampaigns[];
  campaigns: SmartleadCampaign[];
  clients: SmartleadClientRecord[];
  state: StateStore;
  config: Pick<AppConfig, "pocClientNamePatterns">;
  clientId?: number;
}): { emails: string[]; count: number } {
  const clientId = input.clientId ?? POWERGRYD_CLIENT_ID;
  const campaignById = new Map(input.campaigns.map((c) => [c.id, c]));
  const brandByClientId = new Map(
    input.clients.map((client) => [
      client.id,
      brandFromClientDisplayName(clientDisplayName(client)),
    ]),
  );
  const genericOwnerId = pocClientId(
    input.clients,
    input.config.pocClientNamePatterns,
  );
  const emails: string[] = [];
  for (const account of input.accounts) {
    const email = accountEmail(account);
    if (!email) continue;
    if (account.client_id === clientId) {
      emails.push(email);
      continue;
    }
    const memberships = campaignIdsOf(account).map((id) => {
      const campaign = campaignById.get(id);
      return {
        campaignId: id,
        clientId: typeof campaign?.client_id === "number" ? campaign.client_id : null,
        shell: campaign ? isAnyShellCampaign(campaign) : false,
      };
    });
    const dedicated = resolveDedicatedGenericClientId(
      account,
      email,
      memberships,
      input.state,
      { genericOwnerId, brandByClientId },
    );
    if (dedicated === clientId) emails.push(email);
  }
  return { emails: [...new Set(emails)], count: new Set(emails).size };
}

/**
 * D205 — PowerGRYD (592842) is hands-off. Watch dedicated seat count
 * and Slack once per drop. Never mutate memberships or status.
 */
export class PowerGrydWatchService {
  constructor(
    private readonly config: AppConfig,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly smartlead?: import("../clients/smartlead.js").SmartleadClient,
  ) {}

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot } = {},
  ): Promise<PowerGrydWatchResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const clientId = this.config.powerGrydClientId;
    const target = this.config.powerGrydSeatTarget;
    if (!this.config.enablePowerGrydWatch) {
      return {
        dryRun,
        skipped: true,
        reason: "disabled",
        clientId,
        target,
        dedicatedSeats: 0,
        previous: null,
        alerted: false,
      };
    }

    const inventory =
      opts.inventory ??
      (this.smartlead
        ? await fetchInventory(this.smartlead)
        : { campaigns: [], accounts: [], clients: [], fetchedAt: Date.now() });
    const { count } = countPowerGrydDedicatedSeats({
      accounts: inventory.accounts as SmartleadAccountWithCampaigns[],
      campaigns: inventory.campaigns,
      clients: inventory.clients,
      state: this.state,
      config: this.config,
      clientId,
    });
    const previous = this.state.getPowerGrydSeatCount();
    let alerted = false;
    if (previous != null && count < previous && count !== this.state.getPowerGrydAlertedCount()) {
      const line = `PowerGRYD dedicated seats dropped ${previous} → ${count} (target ${target}). Hands-off — I did not peel, restaff, START, or PAUSE anyone.`;
      console.warn(`[powergryd-watch] ${line}`);
      if (!dryRun) {
        await this.slack.send(line, undefined, "ops_alert");
        this.state.setPowerGrydAlertedCount(count);
      }
      alerted = true;
    } else {
      console.log(
        `[powergryd-watch] dedicated=${count} previous=${previous ?? "none"} target=${target}`,
      );
    }
    if (!dryRun) {
      this.state.setPowerGrydSeatCount(count);
      await this.state.save();
    }
    return {
      dryRun,
      clientId,
      target,
      dedicatedSeats: count,
      previous,
      alerted,
    };
  }
}
