/**
 * D248 — weekday 8am CT Needs you post (merged D220 Cayden spend digest).
 * One Approve per client for Cayden spend. Josh-only listed separately.
 * Does not spend.
 */
import type { SlackClient } from "../clients/slack.js";
import { canonOpsIdleReason, chicagoWallClock } from "../lib/canonOpsHours.js";
import { buildNeedsYouDigest } from "../lib/needsYouDigest.js";
import { remindPendingIsolationActions } from "../lib/isolationActions.js";
import type { StateStore } from "../state/store.js";

export interface SpendDigestResult {
  skipped?: boolean;
  reason?: string;
  posted: boolean;
  clients: number;
  items: number;
  flushed?: number;
}

export class SpendDigestService {
  constructor(
    private readonly state: StateStore,
    private readonly slack?: Pick<SlackClient, "send"> &
      Partial<Pick<SlackClient, "notifyIsolationAction" | "postThreadReply">>,
  ) {}

  async postDigest(
    input: { now?: Date; force?: boolean } = {},
  ): Promise<SpendDigestResult> {
    const now = input.now ?? new Date();
    const idle = input.force
      ? undefined
      : canonOpsIdleReason({
          timezone: "America/Chicago",
          weekdayOnly: true,
          hourStart: 0,
          hourEnd: 24,
          now,
        });
    if (idle) {
      return { skipped: true, reason: idle, posted: false, clients: 0, items: 0 };
    }
    const ymd = chicagoWallClock(now, "America/Chicago").ymd;
    if (!input.force && this.state.spendDigestPosted(ymd)) {
      return {
        skipped: true,
        reason: "already-posted",
        posted: false,
        clients: 0,
        items: 0,
      };
    }
    const digest = buildNeedsYouDigest(this.state);
    let posted = false;
    if (digest.text && this.slack?.send) {
      await this.slack.send(digest.text, digest.blocks, "burned_domain");
      posted = true;
    }
    let flushed = 0;
    if (this.slack?.notifyIsolationAction) {
      flushed = await remindPendingIsolationActions({
        store: this.state,
        slack: this.slack as Pick<
          SlackClient,
          "notifyIsolationAction" | "postThreadReply"
        >,
        now,
        oncePerWeekday: true,
      });
    }
    if (posted || flushed) this.state.markSpendDigestPosted(ymd);
    if (!digest.text && !flushed) {
      return {
        skipped: true,
        reason: "none",
        posted: false,
        clients: 0,
        items: 0,
      };
    }
    return {
      posted,
      clients: digest.cayden.length,
      items: digest.items.length + digest.josh.length,
      flushed,
    };
  }
}
