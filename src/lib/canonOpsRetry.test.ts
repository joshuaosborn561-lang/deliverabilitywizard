import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonOpsOverdueDespiteHealthLog,
  canonOpsShouldRetryAfterHealth,
  canonOpsSkipLog,
  canonOpsSkipReason,
  canonOpsTickOverdue,
} from "./canonOpsRetry.js";

describe("D267 canon-ops skipped-tick logging and retry", () => {
  it("logs a reason when health is in flight and retries after", () => {
    const reason = canonOpsSkipReason({
      healthLive: true,
      alreadyRunning: false,
    });
    assert.equal(reason, "health-running");
    assert.match(canonOpsSkipLog(reason!), /Health pass running/);
    assert.match(canonOpsSkipLog(reason!), /will retry after health/);
    assert.equal(canonOpsShouldRetryAfterHealth(reason), true);
  });

  it("D292: overdue hold/min40 is not skipped for a live health pass", () => {
    const reason = canonOpsSkipReason({
      healthLive: true,
      alreadyRunning: false,
      overdue: true,
    });
    assert.equal(reason, undefined);
    assert.match(canonOpsOverdueDespiteHealthLog(), /overdue hold-enforcement\/min40/);
    assert.equal(
      canonOpsSkipReason({
        healthLive: true,
        alreadyRunning: false,
        overdue: false,
      }),
      "health-running",
    );
  });

  it("does not retry an already-running canon-ops pass", () => {
    const reason = canonOpsSkipReason({
      healthLive: true,
      alreadyRunning: true,
    });
    assert.equal(reason, "already-running");
    assert.equal(canonOpsShouldRetryAfterHealth(reason), false);
  });

  it("treats a missing or stale lastOk as an overdue tick", () => {
    assert.equal(canonOpsTickOverdue({ lastOkAt: null }), true);
    assert.equal(
      canonOpsTickOverdue({
        lastOkAt: "2026-10-14T15:32:00.000Z",
        now: Date.parse("2026-10-14T18:05:00.000Z"),
      }),
      true,
    );
    assert.equal(
      canonOpsTickOverdue({
        lastOkAt: "2026-10-14T17:40:00.000Z",
        now: Date.parse("2026-10-14T18:05:00.000Z"),
      }),
      false,
    );
  });
});
