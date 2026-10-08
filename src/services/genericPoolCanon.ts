import type { SlackClient } from "../clients/slack.js";
import type { AppConfig } from "../config.js";
import {
  canaryLockAlertText,
  canaryLockFindingLine,
  validateCanaryLock,
} from "../lib/canaryLock.js";
import {
  genericPoolFindingLine,
  syncGenericSeatsFromInventory,
  validateGenericPool,
} from "../lib/genericPoolCanon.js";
import { migrateClientNamedPoolRecords } from "../lib/clientNamedDomain.js";
import { GENERIC_POOL_POWERGRYD_CLIENT_ID } from "../lib/genericPool.js";
import { openTerlSubstituteEmails } from "../lib/genericSurplusReturn.js";
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
    migrateClientNamedPoolRecords({
      state: this.state,
      accounts: opts.inventory.accounts,
      clients: opts.inventory.clients,
    });
    const existing = this.state.listGenericSeats();
    const synced = syncGenericSeatsFromInventory({
      existing,
      accounts: opts.inventory.accounts,
      campaigns: opts.inventory.campaigns,
      config: this.config,
      state: this.state,
      now: opts.now,
      powerGrydClientId,
    });
    const idleExemptEmails = openTerlSubstituteEmails(
      this.state.listActiveTerlSubstitutions(),
      opts.now,
    );
    const post = validateGenericPool({
      seats: synced.seats,
      namedStaffableByClientPod: synced.namedStaffableByClientPod,
      clientHasActiveCampaign: synced.clientHasActiveCampaign,
      campaignClientById: synced.campaignClientById,
      liveClientIdsByEmail: synced.liveClientIdsByEmail,
      powerGrydClientId,
      idleExemptEmails,
    });
    const pre =
      existing.length === 0
        ? []
        : validateGenericPool({
            seats: existing,
            namedStaffableByClientPod: synced.namedStaffableByClientPod,
            clientHasActiveCampaign: synced.clientHasActiveCampaign,
            campaignClientById: synced.campaignClientById,
            liveClientIdsByEmail: synced.liveClientIdsByEmail,
            powerGrydClientId,
            idleExemptEmails,
          }).filter(
            (row) =>
              row.kind === "generic_outside_table" ||
              row.kind === "generic_multi_client",
          );
    const seen = new Set<string>();
    const findings = [...pre, ...post]
      .filter((row) => {
        const line = genericPoolFindingLine(row);
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      })
      .map(genericPoolFindingLine);
    for (const row of validateCanaryLock({
      accounts: opts.inventory.accounts,
      campaigns: opts.inventory.campaigns,
      state: this.state,
    })) {
      const line = canaryLockFindingLine(row);
      if (seen.has(line)) continue;
      seen.add(line);
      findings.push(line);
    }

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
        const canaryFresh = fresh.filter((line) =>
          line.startsWith("canary_"),
        );
        const poolFresh = fresh.filter((line) => !line.startsWith("canary_"));
        if (canaryFresh.length) {
          await this.slack.send(
            canaryLockAlertText(canaryFresh),
            undefined,
            "canon_miss",
          );
        }
        if (poolFresh.length) {
          await this.slack.send(
            genericPoolFindingAlertText(poolFresh),
            undefined,
            "canon_miss",
          );
        }
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
