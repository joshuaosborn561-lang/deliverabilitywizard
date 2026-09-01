import type { AppConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import {
  humanizeAlertError,
  isRateLimitNoise,
  isThrottleOrTimeoutNoise,
  reconnectFailureCategory,
} from "../lib/alertNoise.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import type { InventoryBook, InventorySnapshot } from "./inventory.js";

const RECONNECT_ALERT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const REEXPORT_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RECONNECT_DEDUPE_INITIALIZED_KEY = "reconnect-alert:dedupe-v1";

export interface ReconnectAction {
  accountId: number;
  email: string;
  type?: string;
  smtpOkBefore?: boolean | null;
  imapOkBefore?: boolean | null;
  smtpError?: string | null;
  imapError?: string | null;
  reauthenticated: boolean;
  skipped: boolean;
  message: string;
}

export interface ReconnectResult {
  dryRun: boolean;
  scanned: number;
  disconnected: number;
  reconnected: number;
  skippedAlreadyConnected: number;
  failed: number;
  actions: ReconnectAction[];
  inboxkitReexports: number;
  errors: string[];
}

/**
 * Daily job: find Smartlead accounts with failed SMTP/IMAP and call /reauth.
 * Also re-queues failed InboxKit → Smartlead exports when configured.
 */
export class AccountReconnectService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly inboxkit: InboxKitClient | null,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly book: InventoryBook,
  ) {}

  async run(opts: { inventory?: InventorySnapshot } = {}): Promise<ReconnectResult> {
    const result: ReconnectResult = {
      dryRun: this.config.dryRun,
      scanned: 0,
      disconnected: 0,
      reconnected: 0,
      skippedAlreadyConnected: 0,
      failed: 0,
      actions: [],
      inboxkitReexports: 0,
      errors: [],
    };

    console.log(
      `[reconnect] Starting (${result.dryRun ? "DRY RUN" : "LIVE"})`,
    );

    // D132 / D94 — same contract as campaign check: a handed snapshot, else
    // the shared book (carry-over on a failed read). Never refetch the
    // mailbox list ourselves; a Smartlead email-accounts 500 must not
    // report Checked 0 while D132 is holding the accepted book.
    let accounts: SmartleadAccountWithCampaigns[] = [];
    try {
      const snapshot = opts.inventory ?? (await this.book.get());
      accounts = snapshot.accounts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list accounts: ${message}`);
      await this.failClosedWithoutBook(result, message);
      return result;
    }

    result.scanned = accounts.length;
    const disconnected = accounts.filter(isDisconnected);
    result.disconnected = disconnected.length;

    for (const account of disconnected) {
      const email = accountEmail(account) || `id:${account.id}`;
      const action: ReconnectAction = {
        accountId: account.id,
        email,
        type: account.type,
        smtpOkBefore: account.is_smtp_success ?? null,
        imapOkBefore: account.is_imap_success ?? null,
        smtpError: (account as { smtp_failure_error?: string | null })
          .smtp_failure_error,
        imapError: (account as { imap_failure_error?: string | null })
          .imap_failure_error,
        reauthenticated: false,
        skipped: false,
        message: "",
      };

      try {
        if (result.dryRun) {
          action.message = "dry-run: would call /reauth";
          action.reauthenticated = true;
          result.reconnected += 1;
        } else {
          const resp = await this.smartlead.reauthEmailAccount(account.id);
          action.reauthenticated = Boolean(resp.reauthenticated);
          action.skipped = Boolean(resp.skipped);
          action.message =
            resp.message ||
            (resp.skipped
              ? "already connected"
              : resp.reauthenticated
                ? "reconnected"
                : "reauth returned ok=false");
          if (resp.skipped) {
            result.skippedAlreadyConnected += 1;
          } else if (resp.ok && resp.reauthenticated) {
            result.reconnected += 1;
            // Re-assert warmup after reconnect (outreach stops when disconnected)
            try {
              await this.smartlead.configureWarmup(account.id, {
                warmup_enabled: true,
                total_warmup_per_day: this.config.warmupTotalPerDay,
                daily_rampup: this.config.warmupDailyRampup,
                reply_rate_percentage: this.config.warmupReplyRatePercentage,
              });
            } catch (warmupError) {
              const warmupMsg =
                warmupError instanceof Error
                  ? warmupError.message
                  : String(warmupError);
              result.errors.push(`warmup after reauth ${email}: ${warmupMsg}`);
            }
          } else {
            result.failed += 1;
            result.errors.push(`reauth ${email}: ${action.message}`);
          }
          await sleep(350);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        action.message = message;
        result.failed += 1;
        result.errors.push(`reauth ${email}: ${message}`);
      }

      result.actions.push(action);
    }

    // Secondary: re-export InboxKit mailboxes that failed Smartlead connection
    if (this.inboxkit && this.config.genericPoolWorkspaceId) {
      try {
        result.inboxkitReexports = await this.reexportFailedInboxKit(
          result.dryRun,
          result.errors,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`inboxkit re-export: ${message}`);
      }
    }

    this.state.setLastReconnectAt(new Date().toISOString());
    await this.finish(result);
    return result;
  }

  /**
   * No accepted book and the mailbox list cannot be read. Fail closed —
   * scanned=0 is not a disconnect wave. 429/timeout stay silent; a vendor
   * 5xx pages once as ops_alert (D149), not as a reconnect action_result.
   */
  private async failClosedWithoutBook(
    result: ReconnectResult,
    message: string,
  ): Promise<void> {
    await this.state.save();
    console.log("[reconnect] Done", {
      dryRun: result.dryRun,
      scanned: 0,
      disconnected: 0,
      failedClosed: true,
      errors: result.errors.length,
    });
    console.warn(
      `[reconnect] mailbox list unavailable and no accepted book — failing closed (not a disconnect wave): ${message}`,
    );

    if (isThrottleOrTimeoutNoise(message)) {
      console.log(
        "[reconnect] Skipping Slack (rate-limit/timeout; next cron retries)",
      );
      return;
    }

    const key = "reconnect-alert:error:mailbox-list-outage";
    if (this.state.hasRecentAlert(key, RECONNECT_ALERT_COOLDOWN_MS)) {
      console.log(
        "[reconnect] Skipping Slack (mailbox-list outage already paged)",
      );
      return;
    }

    try {
      await this.slack.send(
        [
          "Smartlead's mailbox-list API is failing.",
          "This is not a disconnect wave — I could not load the mailbox book, and there is no accepted snapshot to scan.",
          humanizeAlertError(`list accounts: ${message}`),
          "The next health pass will retry. I will not page this again until it recovers.",
        ].join("\n"),
        undefined,
        "ops_alert",
      );
      this.state.markAlert(key);
      await this.state.save();
    } catch (error) {
      console.error("[reconnect] Slack notify failed", error);
    }
  }

  private async reexportFailedInboxKit(
    dryRun: boolean,
    errors: string[],
  ): Promise<number> {
    const ws = this.config.genericPoolWorkspaceId;
    const sequencers = await this.inboxkit!.listSequencers(ws);
    const smartlead = sequencers.find((s) =>
      /smartlead/i.test(String(s.platform ?? s.name ?? "")),
    );
    const seqUid = smartlead?.uid || smartlead?.id;
    if (!seqUid) return 0;

    const status = (await this.inboxkit!.getExportStatus(ws, {
      sequencerUid: String(seqUid),
    })) as { data?: Array<{ status?: string; mailbox_uid?: string }> };
    const rows = Array.isArray(status?.data) ? status.data : [];
    const failedUids = [
      ...new Set(
        rows
          .filter((r) =>
            ["errored", "failed", "pending"].includes(
              String(r.status ?? "").toLowerCase(),
            ),
          )
          .map((r) => r.mailbox_uid)
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    if (!failedUids.length) return 0;
    if (dryRun) return failedUids.length;

    // Pending jobs may already be in flight — export API will skip duplicates.
    let queued = 0;
    for (let i = 0; i < failedUids.length; i += 20) {
      const chunk = failedUids.slice(i, i + 20);
      try {
        await this.inboxkit!.exportMailboxesToSequencer(
          String(seqUid),
          chunk,
          ws,
        );
        queued += chunk.length;
        await sleep(800);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate|already|in progress/i.test(message)) {
          errors.push(`re-export chunk: ${message}`);
        }
      }
    }
    return queued;
  }

  private async finish(result: ReconnectResult): Promise<void> {
    await this.state.save();
    console.log("[reconnect] Done", {
      dryRun: result.dryRun,
      scanned: result.scanned,
      disconnected: result.disconnected,
      reconnected: result.reconnected,
      skipped: result.skippedAlreadyConnected,
      failed: result.failed,
      inboxkitReexports: result.inboxkitReexports,
      errors: result.errors.length,
    });

    const alertKeys: string[] = [];
    const actions = result.actions.filter((action) => {
      if (action.skipped || /already connected/i.test(action.message)) {
        return false;
      }

      if (isRateLimitNoise(action.message)) return false;

      const email = action.email.toLowerCase();
      const key = action.reauthenticated
        ? `reconnect-alert:success:${email}`
        : `reconnect-alert:failure:${email}:${reconnectFailureCategory(action.message)}`;
      if (this.state.hasRecentAlert(key, RECONNECT_ALERT_COOLDOWN_MS)) {
        return false;
      }
      alertKeys.push(key);
      return true;
    });

    // Reauth failures are represented by actions above. Keep only other,
    // non-throttling errors, and dedupe each error category for seven days.
    const errors = result.errors.filter((message) => {
      if (isRateLimitNoise(message) || /^reauth\s/i.test(message)) return false;
      const key = `reconnect-alert:error:${reconnectFailureCategory(message)}`;
      if (this.state.hasRecentAlert(key, RECONNECT_ALERT_COOLDOWN_MS)) {
        return false;
      }
      alertKeys.push(key);
      return true;
    });

    let inboxkitReexports = 0;
    if (result.inboxkitReexports > 0) {
      const key = "reconnect-alert:inboxkit-reexport";
      if (!this.state.hasRecentAlert(key, REEXPORT_ALERT_COOLDOWN_MS)) {
        inboxkitReexports = result.inboxkitReexports;
        alertKeys.push(key);
      }
    }

    const notification: ReconnectResult = {
      ...result,
      disconnected: actions.length,
      reconnected: actions.filter((a) => a.reauthenticated).length,
      failed: actions.filter((a) => !a.reauthenticated).length,
      actions,
      inboxkitReexports,
      errors,
    };

    // State predates reconnect dedupe. Seed the current recurring problems on
    // the first run after this release so the deployment itself doesn't emit
    // one last copy of the already-seen alert.
    if (!this.state.hasAlert(RECONNECT_DEDUPE_INITIALIZED_KEY)) {
      this.state.markAlert(RECONNECT_DEDUPE_INITIALIZED_KEY);
      for (const key of alertKeys) this.state.markAlert(key);
      await this.state.save();
      console.log(
        `[reconnect] Initialized alert dedupe with ${alertKeys.length} current condition(s); Slack suppressed`,
      );
      return;
    }

    if (actions.length || inboxkitReexports || errors.length) {
      try {
        await this.slack.notifyReconnect(notification);
        for (const key of alertKeys) this.state.markAlert(key);
        await this.state.save();
      } catch (error) {
        console.error("[reconnect] Slack notify failed", error);
      }
    } else if (
      result.disconnected > 0 ||
      result.inboxkitReexports > 0 ||
      result.errors.length
    ) {
      console.log(
        `[reconnect] Skipping Slack (${result.disconnected} repeated disconnect(s), ${result.errors.filter(isRateLimitNoise).length} rate-limit error(s))`,
      );
    }
  }
}

export function isDisconnected(
  account: SmartleadAccountWithCampaigns,
): boolean {
  return account.is_smtp_success === false || account.is_imap_success === false;
}
