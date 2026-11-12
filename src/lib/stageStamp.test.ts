import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  finalizeStageStamp,
  runStampedStage,
  STAGE_PASS_SUPERSEDED,
  STAGE_SILENT_EXIT,
} from "./stageStamp.js";
import { isPausedForHealth, PausedForHealthError } from "./healthCpuPause.js";
import { raceStep } from "./stepTimeout.js";

describe("stage stamp (D261)", () => {
  it("finalizeStageStamp writes exited-without-stamp only when nothing landed", () => {
    const errors: string[] = [];
    assert.equal(
      finalizeStageStamp({
        stamped: true,
        name: "isolation-branch",
        recordError: () => errors.push("x"),
      }),
      false,
    );
    assert.deepEqual(errors, []);
    assert.equal(
      finalizeStageStamp({
        stamped: false,
        name: "isolation-branch",
        recordError: (name, message) => errors.push(`${name}:${message}`),
      }),
      true,
    );
    assert.deepEqual(errors, [`isolation-branch:${STAGE_SILENT_EXIT}`]);
  });

  it("success stamps ok; throw stamps the real error; superseded stamps", async () => {
    const ok: string[] = [];
    const err: string[] = [];
    const checkpoints: string[] = [];

    const good = await runStampedStage({
      name: "isolation-branch",
      startedAt: Date.now() - 10,
      run: async () => ({ evaluated: 1 }),
      recordOk: (name) => ok.push(name),
      recordError: (name, message) => err.push(`${name}:${message}`),
      checkpoint: async (name) => {
        checkpoints.push(name);
      },
    });
    assert.deepEqual(good, { evaluated: 1 });
    assert.deepEqual(ok, ["isolation-branch"]);
    assert.deepEqual(err, []);

    const failed = await runStampedStage({
      name: "isolation-branch",
      startedAt: Date.now(),
      run: async () => {
        throw new Error("timeout after 10m");
      },
      recordOk: (name) => ok.push(name),
      recordError: (name, message) => err.push(`${name}:${message}`),
      checkpoint: async (name) => {
        checkpoints.push(name);
      },
    });
    assert.equal(failed, null);
    assert.deepEqual(err, ["isolation-branch:timeout after 10m"]);

    const abandoned = await runStampedStage({
      name: "health-pass",
      startedAt: Date.now(),
      run: async () => {
        throw new Error("should not run");
      },
      abandon: () => STAGE_PASS_SUPERSEDED,
      recordOk: (name) => ok.push(name),
      recordError: (name, message) => err.push(`${name}:${message}`),
      checkpoint: async (name) => {
        checkpoints.push(name);
      },
    });
    assert.equal(abandoned, null);
    assert.ok(err.includes(`health-pass:${STAGE_PASS_SUPERSEDED}`));
    assert.ok(checkpoints.length >= 3);
  });

  it("a path that forgets to stamp still records exited-without-stamp", () => {
    const recorded: string[] = [];
    const stamped = finalizeStageStamp({
      stamped: false,
      name: "isolation-branch",
      recordError: (_name, message) => recorded.push(message),
    });
    assert.equal(stamped, true);
    assert.deepEqual(recorded, [STAGE_SILENT_EXIT]);
  });
});

describe("D336 deferred stage exit", () => {
  it("a PausedForHealth exit stamps neither ok nor error (not timeout after 10m, not a fresh lastOk)", async () => {
    const ok: string[] = [];
    const err: string[] = [];
    const out = await runStampedStage({
      name: "campaign-audit",
      startedAt: Date.now(),
      run: () =>
        raceStep(async () => {
          throw new PausedForHealthError("campaign-audit");
        }, 60_000),
      recordOk: (name, _ms, skip) => ok.push(`${name}:${skip ?? ""}`),
      recordError: (name, message) => err.push(`${name}:${message}`),
      checkpoint: async () => {},
      deferred: (error) => (isPausedForHealth(error) ? "health pass live" : null),
    });
    assert.equal(out, null);
    assert.deepEqual(ok, []);
    assert.deepEqual(err, []);
  });

  it("a real error still stamps when a deferred hook is present", async () => {
    const err: string[] = [];
    await runStampedStage({
      name: "campaign-audit",
      startedAt: Date.now(),
      run: async () => {
        throw new Error("timeout after 10m");
      },
      recordOk: () => assert.fail("no ok"),
      recordError: (name, message) => err.push(`${name}:${message}`),
      checkpoint: async () => {},
      deferred: (error) => (isPausedForHealth(error) ? "health pass live" : null),
    });
    assert.deepEqual(err, ["campaign-audit:timeout after 10m"]);
  });
});
