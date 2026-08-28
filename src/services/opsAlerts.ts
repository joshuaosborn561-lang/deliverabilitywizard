import type { SlackClient } from "../clients/slack.js";
import { overdueStages, type OverdueStage } from "../lib/stageWindows.js";
import type { StateStore } from "../state/store.js";

/**
 * D149 — alerts and watches live on Railway, not in a chat session
 * (Josh, 2026-08-28: "need alerts and watches to live on railway not
 * this env"). The stage watchdog stops being a log line somebody has to
 * come read: a stage newly overdue pages Slack ONCE when its episode
 * starts, says nothing while it stays overdue, and posts one recovery
 * note when it succeeds again. The health pass drives this, so the
 * pager inherits the 15-minute cadence.
 */

const ERROR_SNIPPET = 140;

function fmtWindow(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

export function stageAlertText(rows: OverdueStage[]): string {
  const lines = rows.map((row) => {
    const since = row.lastOkAt ? `last ok ${row.lastOkAt}` : "never succeeded";
    const err = row.lastError
      ? `; last error: ${row.lastError.slice(0, ERROR_SNIPPET)}`
      : "";
    return `• \`${row.name}\` — ${since} (allowed ${fmtWindow(row.windowMs)}); ${row.consecutiveFailures} straight failure(s)${err}`;
  });
  return [
    `:rotating_light: Stage watchdog: ${rows.length} stage(s) overdue (D149)`,
    ...lines,
    "The schedule keeps retrying on its own. One page per outage; a recovery note follows when the stage comes back.",
  ].join("\n");
}

export function stageRecoveryText(
  rows: { name: string; alertedAt: string; lastOkAt: string | null }[],
): string {
  const lines = rows.map(
    (row) =>
      `• \`${row.name}\` — ok at ${row.lastOkAt ?? "unknown"} (paged ${row.alertedAt})`,
  );
  return [
    `:white_check_mark: Stage watchdog: ${rows.length} stage(s) recovered (D149)`,
    ...lines,
  ].join("\n");
}

export async function alertStageAnomalies(input: {
  store: StateStore;
  slack: Pick<SlackClient, "send">;
  dryRun?: boolean;
  now?: number;
}): Promise<{ alerted: string[]; recovered: string[] }> {
  const now = input.now ?? Date.now();
  const health = input.store.listStageHealth();
  const overdue = overdueStages(health, now);
  const overdueNames = new Set(overdue.map((row) => row.name));
  const stamped = input.store.listStageAlerts();

  const fresh = overdue.filter((row) => !(row.name in stamped));
  const recovered = Object.keys(stamped).filter(
    (name) => !overdueNames.has(name),
  );

  if (input.dryRun) {
    if (fresh.length || recovered.length) {
      console.log(
        `[ops-alert] DRY RUN — would page overdue=[${fresh.map((r) => r.name).join(", ")}] recovered=[${recovered.join(", ")}]`,
      );
    }
    return { alerted: [], recovered: [] };
  }

  const result = { alerted: [] as string[], recovered: [] as string[] };

  if (recovered.length) {
    const rows = recovered.map((name) => ({
      name,
      alertedAt: stamped[name],
      lastOkAt: health[name]?.lastOkAt ?? null,
    }));
    try {
      await input.slack.send(stageRecoveryText(rows), undefined, "ops_alert");
      for (const name of recovered) input.store.clearStageAlert(name);
      result.recovered = recovered;
    } catch (error) {
      // Stamp stays; the recovery note re-tries on the next pass.
      console.warn("[ops-alert] recovery page failed", error);
    }
  }

  if (fresh.length) {
    try {
      await input.slack.send(stageAlertText(fresh), undefined, "ops_alert");
      const iso = new Date(now).toISOString();
      for (const row of fresh) input.store.setStageAlert(row.name, iso);
      result.alerted = fresh.map((row) => row.name);
    } catch (error) {
      // No stamp — the page re-tries on the next pass instead of going silent.
      console.warn("[ops-alert] overdue page failed", error);
    }
  }

  return result;
}
