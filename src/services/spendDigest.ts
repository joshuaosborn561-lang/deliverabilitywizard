/**
 * D220 — weekday 7:16am CT Cayden per-client spend digest.
 * Posts one Slack card from existing pending-spend state. Does not spend.
 */
import type { SlackClient } from "../clients/slack.js";
import { canonOpsIdleReason, chicagoWallClock } from "../lib/canonOpsHours.js";
import { buildCaydenSpendDigest } from "../lib/spendDigest.js";
import type { StateStore } from "../state/store.js";

export interface SpendDigestResult {
  skipped?: boolean;
  reason?: string;
  posted: boolean;
  clients: number;
  items: number;
}

export class SpendDigestService {
  constructor(
    private readonly state: StateStore,
    private readonly slack?: Pick<SlackClient, "send">,
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
    const digest = buildCaydenSpendDigest(this.state);
    if (!digest.text) {
      return {
        skipped: true,
        reason: "none",
        posted: false,
        clients: 0,
        items: 0,
      };
    }
    if (this.slack?.send) {
      await this.slack.send(digest.text, undefined, "burned_domain");
    }
    this.state.markSpendDigestPosted(ymd);
    return {
      posted: true,
      clients: digest.groups.length,
      items: digest.items,
    };
  }
}
