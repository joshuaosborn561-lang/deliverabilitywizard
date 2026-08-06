import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { totalDailySendCeiling } from "../lib/sendCeiling.js";

/**
 * Hold every mailbox at the agreed sending settings.
 *
 * Warmup and daily send volume are set per mailbox in Smartlead, so a mailbox
 * added by hand, re-imported, or created by InboxKit arrives on whatever
 * default it happened to get. Nothing reconciled them, so the fleet drifted.
 *
 * This is a convergence pass: it applies the target settings to every mailbox
 * each run, and reports how many it had to change.
 */

export interface MailboxSettingsResult {
  dryRun: boolean;
  scanned: number;
  sendLimitSet: number;
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

  async run(opts: { dryRun?: boolean } = {}): Promise<MailboxSettingsResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: MailboxSettingsResult = {
      dryRun,
      scanned: 0,
      sendLimitSet: 0,
      warmupEnabled: 0,
      errors: [],
    };

    if (!this.config.enforceMailboxSettings) {
      console.log("[mailbox-settings] Disabled (ENFORCE_MAILBOX_SETTINGS=false)");
      return result;
    }

    // Smartlead shares max_email_per_day across warmup + campaign. D11 wants
    // 30 *campaign* sends, so the Smartlead ceiling is campaign + warmup.
    const campaignTarget = this.config.messagePerDay;
    const target = totalDailySendCeiling(this.config);
    const accounts = (await this.smartlead.listAllEmailAccounts({
      fetchCampaigns: false,
    })) as SmartleadAccountWithCampaigns[];
    result.scanned = accounts.length;

    console.log(
      `[mailbox-settings] Converging ${accounts.length} mailbox(es) to ${target}/day Smartlead ceiling (${campaignTarget} campaign + ${this.config.warmupTotalPerDay} warmup)`,
    );

    let consecutiveFailures = 0;

    for (const account of accounts) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;

      // Only write when the value differs — 1,241 needless writes per run
      // would trip the limiter and buy nothing. Coerce: Smartlead often
      // returns max_email_per_day as a string, and `"50" !== 50` was forcing
      // a full-fleet rewrite every health pass (starving staffing).
      const currentRaw = (account as { max_email_per_day?: number | string })
        .max_email_per_day;
      const current =
        typeof currentRaw === "number"
          ? currentRaw
          : typeof currentRaw === "string" && currentRaw.trim() !== ""
            ? Number(currentRaw)
            : NaN;
      const needsLimit = !(Number.isFinite(current) && current === target);
      const warmup = (account as { warmup_details?: { status?: string } | null })
        .warmup_details;
      const needsWarmup =
        !warmup || String(warmup.status ?? "").toUpperCase() !== "ACTIVE";

      if (!needsLimit && !needsWarmup) continue;

      try {
        if (!dryRun && needsLimit) {
          await this.smartlead.setDailySendLimit(account.id, target);
          await sleep(150);
        }
        if (needsLimit) result.sendLimitSet += 1;

        if (!dryRun && needsWarmup) {
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
        // Almost always a 429; back off rather than abandon the fleet.
        await sleep(2000 * consecutiveFailures);
      }
    }

    console.log(
      `[mailbox-settings] Done — ${result.sendLimitSet} send limit(s) set to ${target} (campaign ${campaignTarget} + warmup ${this.config.warmupTotalPerDay}), ${result.warmupEnabled} warmup(s) enabled, ${result.errors.length} error(s)`,
    );
    for (const e of result.errors.slice(0, 10)) {
      console.log(`[mailbox-settings]   error: ${e}`);
    }

    if (!dryRun && (result.sendLimitSet || result.warmupEnabled)) {
      try {
        await this.slack.send(
          `Mailbox settings: ${result.sendLimitSet} mailbox(es) set to ${target}/day total (${campaignTarget} campaign + ${this.config.warmupTotalPerDay} warmup), ${result.warmupEnabled} warmup(s) enabled (of ${result.scanned} scanned).`,
        );
      } catch (error) {
        console.warn("[mailbox-settings] Slack notify failed", error);
      }
    }

    return result;
  }
}
