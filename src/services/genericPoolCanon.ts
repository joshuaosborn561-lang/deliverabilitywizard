import type { SlackClient } from "../clients/slack.js";
import type { AppConfig } from "../config.js";
import {
  genericPoolFindingLine,
  syncGenericSeatsFromInventory,
  validateGenericPool,
} from "../lib/genericPoolCanon.js";
import { GENERIC_POOL_POWERGRYD_CLIENT_ID } from "../lib/genericPool.js";
import type { StateStore } from "../state/store.js";
import type { InventorySnapshot } from "./inventory.js";

export interface GenericPoolCanonResult {
  dryRun: boolean;
  seats: number;
  assigned: number;
  findings: string[];
  alerted: string[];
  recovered: string[];
}

export function genericPoolFindingAlertText(findings: string[]): string {
  const lines = findings.map((line) => `• ${line}`);
  return [
    ":rotating_light: CANON miss: generic pool assignment is wrong (D221)",
    ...lines,
    "A generic is assigned only to bring a client POD up to 40 staffable senders.",
    "Surplus, paused, or replaced seats return to the fleet pool. One seat, one client.",
    "Investigate in-thread. This page is the first alert; /health stays no until the table is clean.",
  ].join("\n");
}

function findingKeys(findings: string[]): string[] {
  return findings.map((line) => {
    const kind = line.split(":")[0]?.trim() || "unknown";
    const email = /\b([^\s:]+@[^\s,]+)/.exec(line)?.[1]?.toLowerCase() ?? line;
    return `generic_pool:${kind}:${email}`;
  });
}

/**
 * D221 — rebuild the generics table from the shared account book and
 * fail / page when a seat is idle-assigned or on more than one client.
 */
export class GenericPoolCanonService {
  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly slack: Pick<SlackClient, "send">,
  ) {}

  async run(opts: {
    inventory: InventorySnapshot;
    dryRun?: boolean;
    now?: Date;
  }): Promise<GenericPoolCanonResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const powerGrydClientId =
      this.config.powerGrydClientId || GENERIC_POOL_POWERGRYD_CLIENT_ID;
    const synced = syncGenericSeatsFromInventory({
      existing: this.state.listGenericSeats(),
      accounts: opts.inventory.accounts,
      campaigns: opts.inventory.campaigns,
      config: this.config,
      state: this.state,
      now: opts.now,
      powerGrydClientId,
    });
    const findings = validateGenericPool({
      seats: synced.seats,
      namedStaffableByClientPod: synced.namedStaffableByClientPod,
      clientHasActiveCampaign: synced.clientHasActiveCampaign,
      campaignClientById: synced.campaignClientById,
      liveClientIdsByEmail: synced.liveClientIdsByEmail,
      powerGrydClientId,
    }).map(genericPoolFindingLine);

    const result: GenericPoolCanonResult = {
      dryRun,
      seats: synced.seats.length,
      assigned: synced.seats.filter((row) => row.assignedClientId != null).length,
      findings,
      alerted: [],
      recovered: [],
    };

    if (!dryRun) {
      this.state.replaceGenericSeats(synced.seats);
      this.state.setGenericPoolFindings(findings);
    }

    const openKeys = new Set(findingKeys(findings));
    const stamped = this.state.listCanonMissAlerts();
    const recovered = Object.keys(stamped).filter(
      (key) => key.startsWith("generic_pool:") && !openKeys.has(key),
    );
    const fresh = findings.filter((_, i) => {
      const key = findingKeys(findings)[i]!;
      return stamped[key] !== "open";
    });

    if (dryRun) {
      if (fresh.length || recovered.length) {
        console.log(
          `[generic-pool] DRY RUN — findings=${findings.length} would page=${fresh.length} recovered=${recovered.length}`,
        );
      }
      return result;
    }

    for (const key of recovered) {
      this.state.clearCanonMissStamp(key);
      result.recovered.push(key);
    }

    if (fresh.length) {
      try {
        await this.slack.send(
          genericPoolFindingAlertText(fresh),
          undefined,
          "ops_alert",
        );
        const keys = findingKeys(fresh);
        for (const key of keys) this.state.setCanonMissStamp(key, "open");
        result.alerted = keys;
      } catch (error) {
        console.warn("[generic-pool] ops_alert failed", error);
      }
    }

    console.log(
      `[generic-pool] seats=${result.seats} assigned=${result.assigned} findings=${findings.length} alerted=${result.alerted.length}`,
    );
    return result;
  }
}
