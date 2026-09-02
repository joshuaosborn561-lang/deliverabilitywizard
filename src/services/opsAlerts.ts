import type { SlackClient } from "../clients/slack.js";
import { canonBoard } from "../lib/canonCompliance.js";
import {
  canonMissText,
  collectCanonMisses,
  type CanonMissKind,
} from "../lib/canonMiss.js";
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

/**
 * D163 — CANON / healthy-sending misses page Slack once per campaign
 * per incident (ugly same-ESP, isolation queued, COPY / INFRA /
 * INCONCLUSIVE). Same incident stays silent across 15-minute sweeps;
 * a transition pages; recovery (inbox back at the bar) clears the stamp.
 */
export async function alertCanonMisses(input: {
  store: StateStore;
  slack: Pick<SlackClient, "send">;
  threshold: number;
  dryRun?: boolean;
}): Promise<{ alerted: string[]; recovered: number[] }> {
  const misses = collectCanonMisses({
    scores: input.store.listPlacementScores(),
    suspects: input.store.listCopySuspects(),
    latestRun: (campaignId) =>
      input.store.latestIsolationRunForCampaign(campaignId),
    threshold: input.threshold,
    extraCampaignIds: input.store
      .listIsolationRuns()
      .map((run) => run.campaignId),
  });
  const missById = new Map(misses.map((row) => [row.campaignId, row]));
  const stamped = input.store.listCanonMissAlerts();
  const fresh = misses.filter(
    (row) => stamped[String(row.campaignId)] !== row.kind,
  );
  const recovered = Object.keys(stamped)
    .map((key) => Number(key))
    .filter((id) => Number.isFinite(id) && !missById.has(id));

  if (input.dryRun) {
    if (fresh.length || recovered.length) {
      console.log(
        `[canon-miss] DRY RUN — would page [${fresh
          .map((row) => `#${row.campaignId}:${row.kind}`)
          .join(", ")}] recovered=[${recovered.join(", ")}]`,
      );
    }
    return { alerted: [], recovered: [] };
  }

  const result = { alerted: [] as string[], recovered: [] as number[] };

  for (const campaignId of recovered) {
    input.store.clearCanonMissAlert(campaignId);
    result.recovered.push(campaignId);
  }

  for (const row of fresh) {
    try {
      await input.slack.send(canonMissText(row), undefined, "ops_alert");
      input.store.setCanonMissAlert(row.campaignId, row.kind);
      result.alerted.push(`${row.campaignId}:${row.kind as CanonMissKind}`);
    } catch (error) {
      console.warn(
        `[canon-miss] page failed for #${row.campaignId} ${row.kind}`,
        error,
      );
    }
  }

  await pageFirstOpenCanonFindings(input, result);
  return result;
}

const FINDING_LABEL: Record<string, string> = {
  understaffed: "not enough inboxes",
  under_warmed: "inboxes still warming",
  missing_signature_tag: "signature hole",
  mailbox_sig: "signature hole",
  mailbox_gap: "send gap too tight",
  mailbox_volume: "daily volume off",
  no_placement_test: "no placement test",
  missing_canary: "no canary",
  inbox_missing_known_good: "inbox missing known-good test",
};

/**
 * Optional D163: first time a campaign is canon-no (core checklist
 * hole), page once. Recovery clears the stamp so a later miss can page.
 */
async function pageFirstOpenCanonFindings(
  input: {
    store: StateStore;
    slack: Pick<SlackClient, "send">;
    dryRun?: boolean;
  },
  result: { alerted: string[]; recovered: number[] },
): Promise<void> {
  const board = canonBoard(input.store.listCampaignChecks());
  const open = board.campaigns.filter((row) => !row.yes);
  const openIds = new Set(open.map((row) => row.campaignId));

  for (const campaignId of board.campaigns
    .filter((row) => row.yes)
    .map((row) => row.campaignId)) {
    const key = `findings:${campaignId}`;
    if (!input.store.getCanonMissStamp(key)) continue;
    if (input.dryRun) continue;
    input.store.clearCanonMissStamp(key);
    if (!openIds.has(campaignId)) result.recovered.push(campaignId);
  }

  if (input.dryRun) return;

  for (const row of open) {
    const key = `findings:${row.campaignId}`;
    if (input.store.getCanonMissStamp(key) === "open") continue;
    const labels = row.fails
      .map((kind) => FINDING_LABEL[kind] ?? kind.replace(/_/g, " "))
      .join(", ");
    const text = [
      `:rotating_light: CANON miss — this campaign is not sending healthy`,
      `• \`${row.name} #${row.campaignId}\` — ${labels}`,
      "Investigate in-thread. The checklist keeps remediating; this page is the first alert.",
    ].join("\n");
    try {
      await input.slack.send(text, undefined, "ops_alert");
      input.store.setCanonMissStamp(key, "open");
      result.alerted.push(`${row.campaignId}:findings`);
    } catch (error) {
      console.warn(
        `[canon-miss] findings page failed for #${row.campaignId}`,
        error,
      );
    }
  }
}
