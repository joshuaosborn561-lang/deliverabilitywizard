/**
 * D334 — daily per-mailbox health snapshot + trend alerts (ALERT ONLY).
 *
 * Reads: the shared inventory (campaigns + email accounts, already listed
 * by the master-key Smartlead client with D331 ownership applied) and one
 * `getMailboxHealthMetrics({ fullData: true })` call for the snapshot day.
 * The Smartlead dependency is typed to that single read method: this
 * service cannot pause, stop, unpause, rest, burn, swap or edit anything.
 */
import type { SmartleadAccountWithCampaigns, SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import {
  buildMailboxHealthRows,
  evaluateMailboxHealthTrends,
  inMailboxHealthHours,
  mailboxHealthAlertText,
  parseSenderDayStats,
  snapshotDateFor,
  trendAlertKey,
  trendFinding,
  type MailboxHealthConfig,
  type MailboxHealthTrend,
} from "../lib/mailboxHealthDaily.js";
import type { MailboxHealthStore } from "../state/mailboxHealthStore.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

/** Read-only Smartlead surface. */
type Smartlead = Pick<SmartleadClient, "getMailboxHealthMetrics">;

export interface MailboxHealthDailyDeps {
  smartlead: Smartlead;
  slack: Pick<SlackClient, "send">;
  state: Pick<StateStore, "hasAlert" | "markAlert" | "save">;
  store: MailboxHealthStore;
  config: MailboxHealthConfig;
  dryRun?: boolean;
  now?: () => Date;
}

export interface MailboxHealthDailyResult {
  date: string | null;
  mailboxes: number;
  withMetrics: number;
  trends: MailboxHealthTrend[];
  alerted: number;
  pruned: number;
  skipped: string[];
  errors: string[];
}

export class MailboxHealthDailyService {
  /** Open findings from the newest stored snapshot (for /health). */
  private open: string[] = [];
  private openDate: string | null = null;

  constructor(private readonly deps: MailboxHealthDailyDeps) {}

  /** Load the newest snapshot's flags so /health has counts after a restart. */
  async loadOpenFindings(): Promise<void> {
    const latest = await this.deps.store.latest();
    this.openDate = latest?.date ?? null;
    this.open = (latest?.trends ?? []).map(trendFinding);
  }

  openFindings(): { date: string | null; findings: string[] } {
    return { date: this.openDate, findings: [...this.open] };
  }

  async run(opts: {
    campaigns: SmartleadCampaign[];
    accounts: SmartleadAccountWithCampaigns[];
    date?: string;
  }): Promise<MailboxHealthDailyResult> {
    const { smartlead, slack, state, store, config } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const result: MailboxHealthDailyResult = {
      date: null,
      mailboxes: 0,
      withMetrics: 0,
      trends: [],
      alerted: 0,
      pruned: 0,
      skipped: [],
      errors: [],
    };
    if (!config.enabled) {
      result.skipped.push("MAILBOX_HEALTH_DAILY_ENABLED is off");
      return result;
    }
    if (!inMailboxHealthHours(now)) {
      result.skipped.push("outside 06:00–19:59 America/Chicago");
      return result;
    }
    const date = opts.date ?? snapshotDateFor(now);
    result.date = date;

    let payload: unknown = null;
    try {
      payload = await smartlead.getMailboxHealthMetrics({
        startDate: date,
        endDate: date,
        fullData: true,
      });
    } catch (error) {
      // Keep going: warmup scores still snapshot; sent/replies/bounces stay null.
      result.errors.push(`health metrics: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stats = parseSenderDayStats(payload);
    const rows = buildMailboxHealthRows({
      date,
      campaigns: opts.campaigns,
      accounts: opts.accounts,
      stats,
    });
    result.mailboxes = rows.length;
    result.withMetrics = rows.filter((r) => r.sent !== null).length;
    if (!rows.length) {
      result.skipped.push("no mailboxes on ACTIVE campaigns");
      return result;
    }

    const rowMap = Object.fromEntries(rows.map((r) => [r.email, r]));
    const lookback = Math.max(
      config.bounceRollingDays,
      config.replyRecentDays + config.replyBaselineDays,
      8,
    );
    const history = await store.history(date, lookback);
    history.set(date, new Map(Object.entries(rowMap)));
    result.trends = evaluateMailboxHealthTrends(date, history, config);

    await store.write({
      date,
      generatedAt: now.toISOString(),
      rows: rowMap,
      trends: result.trends,
      ...(stats.size === 0 ? { metricsMissing: true } : {}),
    });
    result.pruned = (await store.prune(date, config.retentionDays)).length;
    const latest = await store.latest();
    if (latest?.date === date) {
      this.openDate = date;
      this.open = result.trends.map(trendFinding);
    }

    if (!config.alertsEnabled) {
      result.skipped.push("MAILBOX_HEALTH_ALERTS_ENABLED is off");
      return result;
    }
    const fresh = result.trends.filter((t) => !state.hasAlert(trendAlertKey(t)));
    if (!fresh.length) return result;
    if (this.deps.dryRun) {
      result.skipped.push(`dry run: would alert ${fresh.length}`);
      return result;
    }
    try {
      await slack.send(mailboxHealthAlertText(date, fresh), undefined, "ops_alert");
      for (const t of fresh) state.markAlert(trendAlertKey(t));
      result.alerted = fresh.length;
      await state.save();
    } catch (error) {
      result.errors.push(`slack: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }
}
