import type { AppConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";

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
  ) {}

  async run(): Promise<ReconnectResult> {
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

    let accounts: SmartleadAccountWithCampaigns[] = [];
    try {
      accounts = await this.smartlead.listAllEmailAccounts({
        fetchCampaigns: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list accounts: ${message}`);
      await this.finish(result);
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

    if (
      result.disconnected > 0 ||
      result.reconnected > 0 ||
      result.failed > 0 ||
      result.inboxkitReexports > 0 ||
      result.errors.length
    ) {
      await this.slack.notifyReconnect(result).catch((error) => {
        console.error("[reconnect] Slack notify failed", error);
      });
    }
  }
}

export function isDisconnected(
  account: SmartleadAccountWithCampaigns,
): boolean {
  return account.is_smtp_success === false || account.is_imap_success === false;
}
