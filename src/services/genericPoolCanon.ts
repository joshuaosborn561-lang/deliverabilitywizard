import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import { accountEmail } from "../clients/smartlead.js";
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import { mailboxWarmupPerDayTarget } from "../lib/sendCeiling.js";
import { returnGenericToUntaggedPool } from "../lib/genericReturn.js";
import { runGenericLedgerCleanup } from "../lib/genericLedgerCleanup.js";
import { upsertGenericLedgerToSupabase } from "../lib/genericLedgerSupabase.js";
import { sleep } from "../lib/http.js";
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
    "A generic is assigned only to bring a client POD up to 40 staffable senders (D221/D286).",
    "Surplus, paused, or replaced seats return to the fleet pool. One seat, one client.",
    "Ledger findings: generic_outside_ledger / generic_not_warming / generic_on_insight / pod_short_no_free_generic.",
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
    private readonly smartlead?: Pick<
      SmartleadClient,
      "updateEmailAccount" | "configureWarmup" | "removeEmailAccountsFromCampaign"
    > &
      Partial<
        Pick<
          SmartleadClient,
          "ensureTag" | "removeTags" | "addEmailAccountsToCampaign"
        >
      >,
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
    if (this.smartlead) {
      try {
        await runGenericLedgerCleanup({
          config: this.config,
          smartlead: this.smartlead,
          state: this.state,
          accounts: opts.inventory.accounts as SmartleadAccountWithCampaigns[],
          campaigns: opts.inventory.campaigns,
          dryRun,
          now: opts.now,
        });
      } catch (error) {
        console.warn("[generic-ledger] cleanup failed", error);
      }
    }
    const existing = this.state.listGenericSeats();
    const synced = await syncGenericSeatsFromInventory({
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
      minFloorByClient: this.config.minFloorByClient,
      now: opts.now,
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
              row.kind === "generic_outside_ledger" ||
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
      if (this.smartlead) {
        await this.enforceLedgerWrites({
          inventory: opts.inventory,
          warmupOff: synced.warmupOffEmails,
          unassignedWithPodTags: synced.unassignedWithPodTags,
          now: opts.now ?? new Date(),
        });
      }
      const mirror = await upsertGenericLedgerToSupabase({
        seats: synced.seats,
        now: opts.now,
      });
      if (mirror.skipped) {
        console.log(
          `[generic-ledger] supabase skipped (${mirror.reason}) — wizard state is source of truth`,
        );
      } else if (mirror.error) {
        console.warn(`[generic-ledger] supabase upsert failed: ${mirror.error}`);
      } else {
        console.log(`[generic-ledger] supabase upserted=${mirror.upserted}`);
      }
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

  private async enforceLedgerWrites(input: {
    inventory: InventorySnapshot;
    warmupOff: string[];
    unassignedWithPodTags: string[];
    now: Date;
  }): Promise<void> {
    const smartlead = this.smartlead;
    if (!smartlead) return;
    const byEmail = new Map(
      (input.inventory.accounts as SmartleadAccountWithCampaigns[]).map(
        (account) => [accountEmail(account)?.toLowerCase(), account] as const,
      ),
    );
    for (const email of input.warmupOff) {
      const account = byEmail.get(email);
      if (!account || typeof account.id !== "number") continue;
      if (this.state.warmupEnsuredRecently(account.id, input.now.getTime())) {
        continue;
      }
      try {
        await smartlead.configureWarmup(account.id, {
          warmup_enabled: true,
          total_warmup_per_day: mailboxWarmupPerDayTarget(account, this.config),
          daily_rampup: this.config.warmupDailyRampup,
          reply_rate_percentage: this.config.warmupReplyRatePercentage,
        });
        this.state.markWarmupEnsured(account.id, input.now.getTime());
        await sleep(process.env.NODE_TEST_CONTEXT ? 0 : 150);
        console.log(`[generic-ledger] warmup re-enabled ${email}`);
      } catch (error) {
        console.warn(`[generic-ledger] warmup ${email} failed`, error);
      }
    }
    for (const email of input.unassignedWithPodTags) {
      const account = byEmail.get(email);
      if (!account || typeof account.id !== "number") continue;
      const seat = this.state.getGenericSeat(email);
      if (seat?.assignedClientId != null) continue;
      try {
        await returnGenericToUntaggedPool({
          smartlead,
          state: this.state,
          account,
          email,
          reason: "stale_pod_tag",
          now: input.now,
        });
      } catch (error) {
        console.warn(`[generic-ledger] strip tags ${email} failed`, error);
      }
    }
  }
}
