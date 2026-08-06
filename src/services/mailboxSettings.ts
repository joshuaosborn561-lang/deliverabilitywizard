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
import { totalDailySendCeiling } from "../lib/sendCeiling.js";

/**
 * Hold every mailbox at the agreed sending settings.
 *
 * Warmup, daily send volume, min send gap, and signature format are set per
 * mailbox in Smartlead, so a mailbox added by hand, re-imported, or created
 * by InboxKit arrives on whatever default it happened to get. Nothing
 * reconciled them, so the fleet drifted.
 *
 * This is a convergence pass: it applies the target settings to every mailbox
 * each run, and reports how many it had to change.
 */

export interface MailboxSettingsResult {
  dryRun: boolean;
  scanned: number;
  sendLimitSet: number;
  minGapSet: number;
  signatureSet: number;
  warmupEnabled: number;
  errors: string[];
}

/** Consecutive failures before the pass gives up for this run. */
const MAX_CONSECUTIVE_FAILURES = 15;

function readMessagePerDay(account: SmartleadAccountWithCampaigns): number {
  const raw =
    (account as { message_per_day?: number | string }).message_per_day ??
    account.max_email_per_day;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function readMinTimeGapMins(account: SmartleadAccountWithCampaigns): number {
  const raw =
    (account as { minTimeToWaitInMins?: number | string | null })
      .minTimeToWaitInMins ??
    (account as { time_to_wait_in_mins?: number | string | null })
      .time_to_wait_in_mins;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

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

    const clients = await this.smartlead
      .listClients()
      .catch(() => [] as SmartleadClientRecord[]);
    const brandByClientId = new Map<number, string>();
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }

    console.log(
      `[mailbox-settings] Converging ${accounts.length} mailbox(es) to ${target}/day (warmups not included), min gap ${targetGap}m, two-line signatures`,
    );

    let consecutiveFailures = 0;

    for (const account of accounts) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;

      // Only write when the value differs — needless writes trip the limiter.
      // Coerce: Smartlead often returns message_per_day as a string.
      const current = readMessagePerDay(account);
      const needsLimit = !(Number.isFinite(current) && current === target);

      const currentGap = readMinTimeGapMins(account);
      const needsGap = !(Number.isFinite(currentGap) && currentGap === targetGap);

      const clientId =
        typeof account.client_id === "number" && Number.isFinite(account.client_id)
          ? account.client_id
          : null;
      const clientBrand = clientId != null ? brandByClientId.get(clientId) ?? "" : "";
      const desiredSig = desiredMailboxSignature({
        fromName: account.from_name,
        signature: account.signature,
        clientBrand,
      });
      const needsSignature =
        desiredSig != null && (account.signature ?? "") !== desiredSig;

      const warmup = (account as { warmup_details?: { status?: string } | null })
        .warmup_details;
      const needsWarmup =
        !warmup || String(warmup.status ?? "").toUpperCase() !== "ACTIVE";

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
      `[mailbox-settings] Done — ${result.sendLimitSet} send limit(s)→${target}, ${result.minGapSet} min gap(s)→${targetGap}, ${result.signatureSet} signature(s), ${result.warmupEnabled} warmup(s), ${result.errors.length} error(s)`,
    );
    for (const e of result.errors.slice(0, 10)) {
      console.log(`[mailbox-settings]   error: ${e}`);
    }

    if (
      !dryRun &&
      (result.sendLimitSet ||
        result.minGapSet ||
        result.signatureSet ||
        result.warmupEnabled)
    ) {
      try {
        await this.slack.send(
          `Mailbox settings: ${result.sendLimitSet}→${target}/day (warmups not included), ${result.minGapSet}→${targetGap}m gap, ${result.signatureSet} signature(s), ${result.warmupEnabled} warmup(s) (of ${result.scanned} scanned).`,
        );
      } catch (error) {
        console.warn("[mailbox-settings] Slack notify failed", error);
      }
    }

    return result;
  }
}
