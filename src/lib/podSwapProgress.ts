/**
 * D330 — weekly POD swap progress that other services can read.
 *
 * `GET /pod-swap` and `/health`.podSwap return `podSwapSignal`.
 * `in_progress` is true from the first unfinished pass of an ISO week
 * until that week's walk finishes. `started_at` / `finished_at` are
 * ISO timestamps. A retry resumes from `cursor_campaign_id` and skips
 * attach/detach keys already confirmed.
 */

export const POD_SWAP_PASS_BUDGET_MS = 12 * 60 * 1000;

export interface PodSwapProgress {
  isoWeek: number;
  onWeekCohort: "A" | "B";
  startedAt: string;
  finishedAt: string | null;
  phase: "attach" | "detach" | "done";
  cursorCampaignId: number | null;
  /** Campaigns whose on-week attach failed and must be retried. */
  retryCampaignIds: number[];
  /** `a:{campaignId}:{accountId}` adds that returned success. */
  confirmedAttaches: string[];
  /** `d:{campaignId}:{accountId}` removes that returned success. */
  confirmedDetaches: string[];
}

export interface PodSwapSignal {
  in_progress: boolean;
  started_at: string | null;
  finished_at: string | null;
  iso_week: number | null;
  on_week: "A" | "B" | null;
  phase: "attach" | "detach" | "done" | "idle";
  cursor_campaign_id: number | null;
  attach_confirmed: number;
  detach_confirmed: number;
}

const IDLE_SIGNAL: PodSwapSignal = {
  in_progress: false,
  started_at: null,
  finished_at: null,
  iso_week: null,
  on_week: null,
  phase: "idle",
  cursor_campaign_id: null,
  attach_confirmed: 0,
  detach_confirmed: 0,
};

export function podSwapAttachKey(campaignId: number, accountId: number): string {
  return `a:${campaignId}:${accountId}`;
}

export function podSwapDetachKey(campaignId: number, accountId: number): string {
  return `d:${campaignId}:${accountId}`;
}

export function freshPodSwap(
  isoWeek: number,
  onWeekCohort: "A" | "B",
  startedAt: string,
): PodSwapProgress {
  return {
    isoWeek,
    onWeekCohort,
    startedAt,
    finishedAt: null,
    phase: "attach",
    cursorCampaignId: null,
    retryCampaignIds: [],
    confirmedAttaches: [],
    confirmedDetaches: [],
  };
}

/** Resume the open swap for this ISO week, or start a new one. */
export function podSwapForWeek(
  stored: PodSwapProgress | null | undefined,
  isoWeek: number,
  onWeekCohort: "A" | "B",
  startedAt: string,
): PodSwapProgress {
  if (
    stored &&
    stored.isoWeek === isoWeek &&
    stored.onWeekCohort === onWeekCohort &&
    stored.phase !== "done" &&
    typeof stored.startedAt === "string" &&
    stored.startedAt.length > 0
  ) {
    return {
      ...freshPodSwap(isoWeek, onWeekCohort, stored.startedAt),
      ...stored,
      startedAt: stored.startedAt,
      finishedAt: null,
      retryCampaignIds: stored.retryCampaignIds ?? [],
      confirmedAttaches: stored.confirmedAttaches ?? [],
      confirmedDetaches: stored.confirmedDetaches ?? [],
    };
  }
  return freshPodSwap(isoWeek, onWeekCohort, startedAt);
}

export function podSwapSignal(
  progress: PodSwapProgress | null | undefined,
): PodSwapSignal {
  if (!progress || typeof progress.startedAt !== "string" || !progress.startedAt) {
    return IDLE_SIGNAL;
  }
  const phase = progress.phase ?? "attach";
  const finished = typeof progress.finishedAt === "string" ? progress.finishedAt : null;
  return {
    in_progress: finished == null && phase !== "done",
    started_at: progress.startedAt,
    finished_at: phase === "done" ? finished : null,
    iso_week: progress.isoWeek,
    on_week: progress.onWeekCohort,
    phase,
    cursor_campaign_id: progress.cursorCampaignId ?? null,
    attach_confirmed: progress.confirmedAttaches?.length ?? 0,
    detach_confirmed: progress.confirmedDetaches?.length ?? 0,
  };
}
