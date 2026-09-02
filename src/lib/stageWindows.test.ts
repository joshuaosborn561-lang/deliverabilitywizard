import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STAGE_OVERDUE_WINDOWS_MS,
  overdueStages,
  stageHealthView,
  stageIdleReason,
} from "./stageWindows.js";

describe("stageHealthView / overdue (D166)", () => {
  const HEALTH_MS = 45 * 60 * 1000;

  it("marks a six-day-stale pod-cover overdue and a fresh idle tick not", () => {
    const now = Date.parse("2026-09-02T13:30:00.000Z");
    const stale = overdueStages(
      {
        "pod-cover": {
          lastOkAt: "2026-08-27T07:09:11.924Z",
          consecutiveFailures: 0,
          lastError: null,
        },
      },
      now,
    );
    assert.deepEqual(
      stale.map((row) => row.name),
      ["pod-cover"],
      "production 2026-08-27 lastOkAt must be overdue against the 15-minute window",
    );
    assert.equal(stale[0]?.windowMs, HEALTH_MS);

    const idle = stageHealthView(
      {
        "pod-cover": {
          lastOkAt: "2026-09-02T13:25:00.000Z",
          consecutiveFailures: 0,
          lastError: null,
          lastSkipReason: "covered",
        },
        "scan-backfill": {
          lastOkAt: "2026-08-27T07:09:11.924Z",
          consecutiveFailures: 0,
          lastError: null,
        },
      },
      now,
    );
    assert.equal(idle.stages["pod-cover"]?.overdue, false);
    assert.equal(idle.stages["pod-cover"]?.lastSkipReason, "covered");
    assert.equal(
      idle.stages["scan-backfill"]?.overdue,
      false,
      "scan-backfill stays event-driven / never overdue (D116/D131)",
    );
    assert.deepEqual(idle.overdueStages.map((row) => row.name), []);
  });

  it("publishes overdue=true on a missed health-cadence stage", () => {
    const now = Date.parse("2026-09-02T13:30:00.000Z");
    const view = stageHealthView(
      {
        reconnect: {
          lastOkAt: "2026-09-02T12:00:00.000Z",
          consecutiveFailures: 2,
          lastError: "HTTP 429",
        },
      },
      now,
    );
    assert.equal(view.stages.reconnect?.overdue, true);
    assert.equal(view.stages.reconnect?.lastError, "HTTP 429");
    assert.equal(view.overdueStages.length, 1);
    assert.equal(view.overdueStages[0]?.name, "reconnect");
  });

  it("reads idle skip reasons from stage() results and ignores real work", () => {
    assert.equal(
      stageIdleReason({ skipped: true, reason: "covered" }),
      "covered",
    );
    assert.equal(stageIdleReason({ skipped: true, reason: "throttled" }), "throttled");
    assert.equal(stageIdleReason({ skipped: true, reason: "disabled" }), "disabled");
    assert.equal(stageIdleReason({ pods: 4, testsCreated: [] }), undefined);
    assert.equal(stageIdleReason(null), undefined);
    assert.equal(stageIdleReason({ skipped: true }), undefined);
  });

  it("keeps scan-backfill on a null window and pod-cover on HEALTH_MS", () => {
    assert.equal(STAGE_OVERDUE_WINDOWS_MS["scan-backfill"], null);
    assert.equal(STAGE_OVERDUE_WINDOWS_MS["pod-cover"], HEALTH_MS);
  });
});
