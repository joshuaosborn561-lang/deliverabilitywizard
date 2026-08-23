import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import {
  brandFromClientDisplayName,
  desiredMailboxSignature,
} from "../lib/mailboxSignature.js";
import {
  needsMinTimeGap,
  readMessagePerDay,
  readMinTimeGapMins,
} from "../lib/mailboxSendSettings.js";
import { totalDailySendCeiling } from "../lib/sendCeiling.js";

/**
 * Hold every mailbox at the agreed sending settings.
 *
 * Warmup, daily send volume, min send gap, and signature format are set per
 * mailbox in Smartlead, so a mailbox added by hand, re-imported, or created
 * by InboxKit arrives on whatever default it happened to get. Nothing
 * reconciled them, so the fleet drifted.
 *
 * Gap + daily volume (D24/D30) run on every health pass. Signatures/warmup
 * stay on the slower full converge so a fleet rewrite cannot starve staffing.
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
  errors: string[];
}

/** Consecutive failures before the pass gives up for this run. */
const MAX_CONSECUTIVE_FAILURES = 15;

export class MailboxSettingsService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
  ) {}

  /** D30/D24 only — safe to run every health cron. */
  async runGapEnforce(
    opts: { dryRun?: boolean } = {},
  ): Promise<MailboxSettingsResult> {
    return this.run({ ...opts, mode: "gap" });
  }

  async run(
    opts: { dryRun?: boolean; mode?: MailboxSettingsMode } = {},
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
      errors: [],
    };

    if (!this.config.enforceMailboxSettings) {
      console.log("[mailbox-settings] Disabled (ENFORCE_MAILBOX_SETTINGS=false)");
      return result;
    }

    // UI: "Message Per Day (Warmups not included)" — write MESSAGE_PER_DAY (D24).
    const target = totalDailySendCeiling(this.config);
    const targetGap = this.config.mailboxMinTimeGapMins;
    const accounts = (await this.smartlead.listAllEmailAccounts({
      fetchCampaigns: false,
    })) as SmartleadAccountWithCampaigns[];
    result.scanned = accounts.length;

    const brandByClientId = new Map<number, string>();
    if (mode === "full") {
      const clients = await this.smartlead
        .listClients()
        .catch(() => [] as SmartleadClientRecord[]);
      for (const client of clients) {
        brandByClientId.set(
          client.id,
          brandFromClientDisplayName(clientDisplayName(client)),
        );
      }
    }

    console.log(
      `[mailbox-settings] mode=${mode} converging ${accounts.length} mailbox(es) to ${target}/day, min gap ${targetGap}m` +
        (mode === "full" ? ", signatures/warmup" : " (gap+volume only)"),
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

      if (mode === "full") {
        const clientId =
          typeof account.client_id === "number" && Number.isFinite(account.client_id)
            ? account.client_id
            : null;
        const clientBrand =
          clientId != null ? brandByClientId.get(clientId) ?? "" : "";
        desiredSig = desiredMailboxSignature({
          fromName: account.from_name,
          signature: account.signature,
          clientBrand,
        });
        needsSignature =
          desiredSig != null && (account.signature ?? "") !== desiredSig;

        const warmup = (account as { warmup_details?: { status?: string } | null })
          .warmup_details;
        needsWarmup =
          !warmup || String(warmup.status ?? "").toUpperCase() !== "ACTIVE";
      }

      if (!needsLimit && !needsGap && !needsSignature && !needsWarmup) continue;

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
      `[mailbox-settings] Done (${mode}) — ${result.sendLimitSet} send limit(s)→${target}, ${result.minGapSet} min gap(s)→${targetGap}, ${result.signatureSet} signature(s), ${result.warmupEnabled} warmup(s), ${result.errors.length} error(s)`,
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
