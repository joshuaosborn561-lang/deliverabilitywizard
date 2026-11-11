/**
 * D335 — weekly mailbox health report. Reads the D334 snapshot files only
 * (no Smartlead dependency at all) and posts one concise Slack report per
 * week to the wizard's report lane (`eod_summary`, same as the EOD
 * scoreboard). Alert only: it cannot pause, stop, rest, swap or test.
 */
import type { SlackClient } from "../clients/slack.js";
import { addDays, inMailboxHealthHours } from "../lib/mailboxHealthDaily.js";
import {
  buildWeeklyHealthReport,
  lastCompletedWeek,
  weekDates,
  weekStartOf,
  weeklyHealthAlertKey,
  weeklyHealthSlackText,
  type WeeklyHealthConfig,
  type WeeklyHealthReport,
  type WeeklyInputDay,
} from "../lib/mailboxHealthWeekly.js";
import type { MailboxHealthStore } from "../state/mailboxHealthStore.js";
import type { StateStore } from "../state/store.js";

export interface MailboxHealthWeeklyDeps {
  slack: Pick<SlackClient, "send">;
  state: Pick<StateStore, "hasAlert" | "markAlert" | "save">;
  store: Pick<MailboxHealthStore, "read">;
  config: WeeklyHealthConfig;
  dryRun?: boolean;
  now?: () => Date;
}

export interface MailboxHealthWeeklyResult {
  week: string | null;
  posted: boolean;
  inboxes: number;
  flaggedInboxes: number;
  skipped: string[];
  errors: string[];
}

export class MailboxHealthWeeklyService {
  constructor(private readonly deps: MailboxHealthWeeklyDeps) {}

  private async readWeek(weekStart: string): Promise<WeeklyInputDay[]> {
    const out: WeeklyInputDay[] = [];
    for (const date of weekDates(weekStart)) {
      const day = await this.deps.store.read(date);
      if (day) out.push({ date: day.date, rows: day.rows, trends: day.trends ?? [] });
    }
    return out;
  }

  /** Report for the Mon–Sun week containing `week`; null when no snapshot exists that week. */
  async report(week: string): Promise<WeeklyHealthReport | null> {
    const start = weekStartOf(week);
    const days = await this.readWeek(start);
    if (!days.length) return null;
    const priorDays = await this.readWeek(addDays(start, -7));
    return buildWeeklyHealthReport({ week: start, days, priorDays });
  }

  /** Cron / catch-up entry: post the last completed week once. */
  async run(opts: { week?: string } = {}): Promise<MailboxHealthWeeklyResult> {
    const { slack, state, config } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const result: MailboxHealthWeeklyResult = {
      week: null,
      posted: false,
      inboxes: 0,
      flaggedInboxes: 0,
      skipped: [],
      errors: [],
    };
    if (!config.enabled) {
      result.skipped.push("WEEKLY_HEALTH_REPORT_ENABLED is off");
      return result;
    }
    if (!inMailboxHealthHours(now)) {
      result.skipped.push("outside 06:00–19:59 America/Chicago");
      return result;
    }
    const week = weekStartOf(opts.week ?? lastCompletedWeek(now));
    result.week = week;
    const key = weeklyHealthAlertKey(week);
    if (state.hasAlert(key)) {
      result.skipped.push(`already posted ${week}`);
      return result;
    }
    const report = await this.report(week);
    if (!report) {
      result.skipped.push(`no daily snapshots for week of ${week}`);
      return result;
    }
    result.inboxes = report.totals.inboxes;
    result.flaggedInboxes = report.totals.flaggedInboxes;
    if (this.deps.dryRun) {
      result.skipped.push("dry run: would post weekly report");
      return result;
    }
    try {
      await slack.send(weeklyHealthSlackText(report), undefined, "eod_summary");
      state.markAlert(key);
      await state.save();
      result.posted = true;
    } catch (error) {
      result.errors.push(`slack: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }
}
