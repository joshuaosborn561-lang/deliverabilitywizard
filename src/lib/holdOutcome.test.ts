import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyHoldOutcome } from "./holdOutcome.js";

describe("classifyHoldOutcome", () => {
  it("holds when every removal succeeded and warmup came back on", () => {
    assert.equal(
      classifyHoldOutcome({
        removeFailures: 0,
        warmupOk: true,
        removedCount: 3,
        dryRun: false,
      }),
      "hold",
    );
  });

  it("refuses to hold when a campaign removal failed", () => {
    // The regression: warmup succeeded, so the old `!warmupOk && removed===0`
    // gate let this through and sealed a still-sending mailbox as benched.
    assert.equal(
      classifyHoldOutcome({
        removeFailures: 2,
        warmupOk: true,
        removedCount: 0,
        dryRun: false,
      }),
      "retry-removal-failed",
    );
  });

  it("refuses to hold on a partial removal", () => {
    assert.equal(
      classifyHoldOutcome({
        removeFailures: 1,
        warmupOk: true,
        removedCount: 5,
        dryRun: false,
      }),
      "retry-removal-failed",
    );
  });

  it("holds a mailbox that was already on no campaigns", () => {
    // Nothing to remove is not a failure — warmup alone benches it.
    assert.equal(
      classifyHoldOutcome({
        removeFailures: 0,
        warmupOk: true,
        removedCount: 0,
        dryRun: false,
      }),
      "hold",
    );
  });

  it("retries when nothing at all was achieved", () => {
    assert.equal(
      classifyHoldOutcome({
        removeFailures: 0,
        warmupOk: false,
        removedCount: 0,
        dryRun: false,
      }),
      "retry-nothing-achieved",
    );
  });

  it("treats a dry run as holdable — it writes nothing to half-do", () => {
    assert.equal(
      classifyHoldOutcome({
        removeFailures: 3,
        warmupOk: false,
        removedCount: 0,
        dryRun: true,
      }),
      "hold",
    );
  });
});
