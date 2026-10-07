import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  raceStep,
  stepTimeoutMs,
  timeoutAfterMessage,
} from "./stepTimeout.js";

describe("D247 step timeout", () => {
  it("budgets inventory 5m, campaign-check-first 20m, scan-backfill 20m, else 10m", () => {
    assert.equal(stepTimeoutMs("inventory"), 5 * 60 * 1000);
    assert.equal(stepTimeoutMs("campaign-check-first"), 20 * 60 * 1000);
    assert.equal(stepTimeoutMs("scan-backfill"), 20 * 60 * 1000);
    assert.equal(stepTimeoutMs("warmup-gate"), DEFAULT_STEP_TIMEOUT_MS);
    assert.equal(timeoutAfterMessage(10 * 60 * 1000), "timeout after 10m");
    assert.equal(timeoutAfterMessage(5 * 60 * 1000), "timeout after 5m");
    assert.equal(timeoutAfterMessage(20 * 60 * 1000), "timeout after 20m");
  });

  it("rejects a hung step with timeout after Nm and aborts the signal", async () => {
    let aborted = false;
    await assert.rejects(
      () =>
        raceStep(async (signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 200));
          return "done";
        }, 20),
      (error: unknown) => {
        assert.equal(error instanceof Error && error.message, true);
        assert.match(String((error as Error).message), /^timeout after \d+m$/);
        return true;
      },
    );
    assert.equal(aborted, true);
  });

  it("returns the step result when it finishes inside the budget", async () => {
    const value = await raceStep(async () => "ok", 200);
    assert.equal(value, "ok");
  });
});
