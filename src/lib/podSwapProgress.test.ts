import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  freshPodSwap,
  podSwapForWeek,
  podSwapSignal,
} from "./podSwapProgress.js";

describe("podSwap signal (D330)", () => {
  it("is idle with no progress and in progress until finished_at", () => {
    assert.equal(podSwapSignal(null).in_progress, false);
    assert.equal(podSwapSignal(null).phase, "idle");
    assert.equal(podSwapSignal(null).started_at, null);

    const open = freshPodSwap(46, "B", "2026-11-09T06:02:11.000Z");
    open.cursorCampaignId = 3815448;
    open.confirmedAttaches = ["a:1:2"];
    const signal = podSwapSignal(open);
    assert.equal(signal.in_progress, true);
    assert.equal(signal.started_at, "2026-11-09T06:02:11.000Z");
    assert.equal(signal.finished_at, null);
    assert.equal(signal.iso_week, 46);
    assert.equal(signal.on_week, "B");
    assert.equal(signal.phase, "attach");
    assert.equal(signal.cursor_campaign_id, 3815448);
    assert.equal(signal.attach_confirmed, 1);

    const done = {
      ...open,
      phase: "done" as const,
      finishedAt: "2026-11-09T08:00:00.000Z",
    };
    const closed = podSwapSignal(done);
    assert.equal(closed.in_progress, false);
    assert.equal(closed.finished_at, "2026-11-09T08:00:00.000Z");
    assert.equal(closed.phase, "done");
  });

  it("resumes the same ISO week and starts over after it finishes", () => {
    const open = freshPodSwap(46, "B", "2026-11-09T06:02:11.000Z");
    open.confirmedAttaches = ["a:9:101"];
    open.cursorCampaignId = 9;
    const resumed = podSwapForWeek(open, 46, "B", "2026-11-09T07:00:00.000Z");
    assert.equal(resumed.startedAt, open.startedAt);
    assert.deepEqual(resumed.confirmedAttaches, ["a:9:101"]);
    assert.equal(resumed.cursorCampaignId, 9);

    const done = { ...open, phase: "done" as const, finishedAt: "2026-11-09T08:00:00.000Z" };
    const next = podSwapForWeek(done, 46, "B", "2026-11-09T09:00:00.000Z");
    assert.equal(next.startedAt, "2026-11-09T09:00:00.000Z");
    assert.deepEqual(next.confirmedAttaches, []);

    const flipped = podSwapForWeek(open, 47, "A", "2026-11-16T06:00:00.000Z");
    assert.equal(flipped.onWeekCohort, "A");
    assert.equal(flipped.isoWeek, 47);
    assert.deepEqual(flipped.confirmedAttaches, []);
  });
});
