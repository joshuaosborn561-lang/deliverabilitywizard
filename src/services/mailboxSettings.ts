import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import {
  brandFromClientDisplayName,
  clientBrandList,
  findForeignBrand,
} from "../lib/clientBrand.js";
import { desiredMailboxSignature } from "../lib/mailboxSignature.js";
import { signatureHay } from "../lib/signatureQa.js";
import type { SmartleadCampaign } from "../types/index.js";
import {
  mailboxWarmupIsOn,
  needsMinTimeGap,
  readMessagePerDay,
  readMinTimeGapMins,
} from "../lib/mailboxSendSettings.js";
import { totalDailySendCeiling } from "../lib/sendCeiling.js";
import type { StateStore } from "../state/store.js";
import { fetchInventory, type InventorySnapshot } from "./inventory.js";

/**
 * Hold every mailbox at the agreed sending settings.
 *
 * Warmup, daily send volume, min send gap, and signature format are set per
 * mailbox in Smartlead, so a mailbox added by hand, re-imported, or created
 * by InboxKit arrives on whatever default it happened to get. Nothing
 * reconciled them, so the fleet drifted.
 *
 * Gap + daily volume (D24/D30) run on every health pass. Canary-fleet
 * warmup-off (D83) runs on that same pass. Signatures and everyone-else
 * warmup stay on the slower full converge so a fleet rewrite cannot
 * starve staffing.
 */

export type MailboxSettingsMode = "gap" | "full";

export interface MailboxSettingsResult {
  dryRun: boolean;
  mode: MailboxSettingsMode;
  scanned: number;
  sendLimitSet: number;
  minGapSet: number;
  signatureSet: number;
  warmupEnabled: number;
  /** D83 — unwarmed canary fleet had warmup turned off. */
  warmupDisabled: number;
  errors: string[];
}

/** Consecutive failures before the pass gives up for this run. */
const MAX_CONSECUTIVE_FAILURES = 15;

export class MailboxSettingsService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly store?: StateStore,
  ) {}

  /** D30/D24 only — safe to run every health cron. */
  async runGapEnforce(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot } = {},
  ): Promise<MailboxSettingsResult> {
    return this.run({ ...opts, mode: "gap" });
  }

  async run(
    opts: {
      dryRun?: boolean;
      mode?: MailboxSettingsMode;
      inventory?: InventorySnapshot;
    } = {},
  ): Promise<MailboxSettingsResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const mode: MailboxSettingsMode = opts.mode ?? "full";
    const result: MailboxSettingsResult = {
      dryRun,
      mode,
      scanned: 0,
      sendLimitSet: 0,
      minGapSet: 0,
      signatureSet: 0,
      warmupEnabled: 0,
      warmupDisabled: 0,
      errors: [],
    };

    if (!this.config.enforceMailboxSettings) {
      console.log("[mailbox-settings] Disabled (ENFORCE_MAILBOX_SETTINGS=false)");
      return result;
    }

    // UI: "Message Per Day (Warmups not included)" — write MESSAGE_PER_DAY (D24).
    const target = totalDailySendCeiling(this.config);
    const targetGap = this.config.mailboxMinTimeGapMins;
    const { accounts, clients, campaigns } =
      opts.inventory ?? (await fetchInventory(this.smartlead));
    result.scanned = accounts.length;

    const brandByClientId = new Map<number, string>();
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }
    const allBrands = clientBrandList(clients);
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((campaign) => [campaign.id, campaign]),
    );

    console.log(
      `[mailbox-settings] mode=${mode} converging ${accounts.length} mailbox(es) to ${target}/day, min gap ${targetGap}m` +
        (mode === "full"
          ? ", signatures/warmup"
          : " (gap+volume; foreign-brand sigs; canary warmup off)"),
    );

    let consecutiveFailures = 0;

    for (const account of accounts) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;

      // Only write when the value differs — needless writes trip the limiter.
      const current = readMessagePerDay(account);
      const needsLimit = !(Number.isFinite(current) && current === target);

      const needsGap = needsMinTimeGap(account, targetGap);

      let needsSignature = false;
      let desiredSig: string | null = null;
      let needsWarmup = false;
      let needsWarmupOff = false;
      const canary = this.store?.isCopyCanary(email) ?? false;
      const warmupOn = mailboxWarmupIsOn(account);
      if (canary && warmupOn) needsWarmupOff = true;

      const clientBrand = sendingBrandForAccount(
        account,
        campaignById,
        brandByClientId,
      );
      const otherBrands = allBrands.filter((brand) => brand !== clientBrand);
      const hay = signatureHay({
        fromName: account.from_name,
        signature: account.signature,
      });
      const foreign = clientBrand
        ? findForeignBrand(hay, clientBrand, allBrands)
        : null;
      desiredSig = desiredMailboxSignature({
        fromName: account.from_name,
        signature: account.signature,
        clientBrand,
        otherClientBrands: otherBrands,
      });
      if (mode === "full") {
        needsSignature =
          desiredSig != null && (account.signature ?? "") !== desiredSig;

        needsWarmup = !canary && !warmupOn;
      } else if (foreign && desiredSig && (account.signature ?? "") !== desiredSig) {
        // D74 — do not wait six hours to pull a Peterson line off a Goliath send.
        needsSignature = true;
      }

      if (
        !needsLimit &&
        !needsGap &&
        !needsSignature &&
        !needsWarmup &&
        !needsWarmupOff
      ) {
        continue;
      }

      try {
        if (!dryRun && (needsLimit || needsGap || needsSignature)) {
          const fields: {
            max_email_per_day?: number;
            time_to_wait_in_mins?: number;
            signature?: string;
          } = {};
          if (needsLimit) fields.max_email_per_day = target;
          if (needsGap) fields.time_to_wait_in_mins = targetGap;
          if (needsSignature && desiredSig) fields.signature = desiredSig;
          await this.smartlead.updateEmailAccount(account.id, fields);
          await sleep(150);
        }
        if (needsLimit) result.sendLimitSet += 1;
        if (needsGap) result.minGapSet += 1;
        if (needsSignature) result.signatureSet += 1;

        if (!dryRun && needsWarmupOff) {
          await this.smartlead.configureWarmup(account.id, {
            warmup_enabled: false,
            total_warmup_per_day: this.config.warmupTotalPerDay,
            daily_rampup: this.config.warmupDailyRampup,
            reply_rate_percentage: this.config.warmupReplyRatePercentage,
          });
          await sleep(150);
        }
        if (needsWarmupOff) result.warmupDisabled += 1;

        if (mode === "full" && !dryRun && needsWarmup) {
          await this.smartlead.configureWarmup(account.id, {
            warmup_enabled: true,
            total_warmup_per_day: this.config.warmupTotalPerDay,
            daily_rampup: this.config.warmupDailyRampup,
            reply_rate_percentage: this.config.warmupReplyRatePercentage,
          });
          await sleep(150);
        }
        if (needsWarmup) result.warmupEnabled += 1;

        consecutiveFailures = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${email}: ${message}`);
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(
            `[mailbox-settings] ${consecutiveFailures} consecutive failures — stopping this run`,
          );
          break;
        }
        await sleep(2000 * consecutiveFailures);
      }
    }

    console.log(
      `[mailbox-settings] Done (${mode}) — ${result.sendLimitSet} send limit(s)→${target}, ${result.minGapSet} min gap(s)→${targetGap}, ${result.signatureSet} signature(s), ${result.warmupEnabled} warmup(s) on, ${result.warmupDisabled} canary warmup(s) off, ${result.errors.length} error(s)`,
    );
    for (const e of result.errors.slice(0, 10)) {
      console.log(`[mailbox-settings]   error: ${e}`);
    }

    if (!dryRun && result.minGapSet > 0) {
      try {
        await this.slack.send(
          `*Sending pace*\n${result.minGapSet} inbox${result.minGapSet === 1 ? "" : "es"} ${result.minGapSet === 1 ? "was" : "were"} sending closer together than ${targetGap} minutes. Set back to ${targetGap} minutes. We check this every staffing pass.`,
        );
      } catch (error) {
        console.warn("[mailbox-settings] Slack gap alert failed", error);
      }
    }

    if (
      mode === "full" &&
      !dryRun &&
      (result.sendLimitSet ||
        result.minGapSet ||
        result.signatureSet ||
        result.warmupEnabled)
    ) {
      try {
        await this.slack.send(
          [
            `*Inbox settings*`,
            `${result.sendLimitSet} inbox${result.sendLimitSet === 1 ? "" : "es"} set to ${target} campaign emails/day.`,
            `${result.minGapSet} set to ${targetGap} minutes apart.`,
            `${result.signatureSet} signature${result.signatureSet === 1 ? "" : "s"} set to name + company.`,
            `${result.warmupEnabled} warmup${result.warmupEnabled === 1 ? "" : "s"} turned on.`,
            `(Looked at ${result.scanned}.)`,
          ].join("\n"),
        );
      } catch (error) {
        console.warn("[mailbox-settings] Slack notify failed", error);
      }
    }

    return result;
  }
}

export { readMessagePerDay, readMinTimeGapMins, needsMinTimeGap };

/** Brand the mailbox is actually sending as: live campaign client, else mailbox client. */
export function sendingBrandForAccount(
  account: SmartleadAccountWithCampaigns,
  campaignById: Map<number, SmartleadCampaign>,
  brandByClientId: Map<number, string>,
): string {
  const campaignBrands = new Set<string>();
  for (const id of campaignIdsOf(account)) {
    const campaign = campaignById.get(id);
    if (!campaign) continue;
    if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") continue;
    const brand =
      typeof campaign.client_id === "number"
        ? brandByClientId.get(campaign.client_id)
        : undefined;
    if (brand) campaignBrands.add(brand);
  }
  if (campaignBrands.size === 1) return [...campaignBrands][0]!;
  const clientId =
    typeof account.client_id === "number" && Number.isFinite(account.client_id)
      ? account.client_id
      : null;
  return (clientId != null ? brandByClientId.get(clientId) : undefined) ?? "";
}
