import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  monitorShouldRetryAfterHealth,
  monitorSkipLog,
  monitorSkipReason,
} from "./monitorPassRetry.js";

describe("D270 monitor skipped-tick logging and retry", () => {
  it("logs a reason when health is in flight and retries after", () => {
    const reason = monitorSkipReason({
      healthLive: true,
      alreadyRunning: false,
    });
    assert.equal(reason, "health-running");
    assert.match(monitorSkipLog(reason!), /Health pass running/);
    assert.match(monitorSkipLog(reason!), /will retry after health/);
    assert.equal(monitorShouldRetryAfterHealth(reason), true);
  });

  it("does not retry an already-running monitor pass", () => {
    const reason = monitorSkipReason({
      healthLive: true,
      alreadyRunning: true,
    });
    assert.equal(reason, "already-running");
    assert.equal(monitorShouldRetryAfterHealth(reason), false);
  });
});
