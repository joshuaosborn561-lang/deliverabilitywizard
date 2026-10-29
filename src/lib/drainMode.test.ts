import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ActiveJobs,
  DRAIN_DEFAULT_MS,
  DRAIN_MAX_MS,
  DrainMode,
  deploySafety,
  parseDrainMinutes,
} from "./drainMode.js";

describe("D308 drain mode", () => {
  it("is off by default and never skips a job", () => {
    const drain = new DrainMode();
    assert.equal(drain.isDraining(1_000), false);
    assert.equal(drain.shouldSkip("health", 1_000), false);
    assert.deepEqual(drain.snapshot(1_000).skipped, {});
  });

  it("skips and counts every new tick while draining", () => {
    const drain = new DrainMode();
    drain.start({ now: 1_000, reason: "deploy A0" });
    assert.equal(drain.shouldSkip("health", 2_000), true);
    assert.equal(drain.shouldSkip("health", 3_000), true);
    assert.equal(drain.shouldSkip("monitor", 3_000), true);
    const snap = drain.snapshot(4_000);
    assert.equal(snap.draining, true);
    assert.equal(snap.reason, "deploy A0");
    assert.deepEqual(snap.skipped, { health: 2, monitor: 1 });
  });

  it("auto-expires so a forgotten drain cannot silence the machine", () => {
    const drain = new DrainMode();
    drain.start({ now: 0 });
    assert.equal(drain.isDraining(DRAIN_DEFAULT_MS - 1), true);
    assert.equal(drain.isDraining(DRAIN_DEFAULT_MS), false);
    assert.equal(drain.shouldSkip("health", DRAIN_DEFAULT_MS + 1), false);
  });

  it("clamps a long request to the maximum", () => {
    const drain = new DrainMode();
    const snap = drain.start({ now: 0, maxMs: 10 * DRAIN_MAX_MS });
    assert.equal(snap.expiresAt, new Date(DRAIN_MAX_MS).toISOString());
    assert.equal(parseDrainMinutes("9999"), DRAIN_MAX_MS);
    assert.equal(parseDrainMinutes("5"), 5 * 60_000);
    assert.equal(parseDrainMinutes("nope"), undefined);
    assert.equal(parseDrainMinutes("-3"), undefined);
    assert.equal(parseDrainMinutes(undefined), undefined);
  });

  it("start again extends the same drain and keeps its counts; stop clears", () => {
    const drain = new DrainMode();
    drain.start({ now: 0 });
    drain.shouldSkip("health", 10);
    const extended = drain.start({ now: 20, maxMs: 60_000 });
    assert.equal(extended.since, new Date(0).toISOString());
    assert.deepEqual(extended.skipped, { health: 1 });
    const off = drain.stop(30);
    assert.equal(off.draining, false);
    assert.equal(drain.shouldSkip("health", 31), false);
    assert.deepEqual(drain.snapshot(31).skipped, {});
  });

  it("a fresh drain after expiry resets the skip counts", () => {
    const drain = new DrainMode();
    drain.start({ now: 0, maxMs: 1_000 });
    drain.shouldSkip("health", 500);
    assert.equal(drain.isDraining(1_500), false);
    const next = drain.start({ now: 2_000, maxMs: 1_000 });
    assert.deepEqual(next.skipped, {});
  });
});

describe("D308 active jobs and safeToDeploy", () => {
  it("tracks a running job until it settles, resolved or rejected", async () => {
    const jobs = new ActiveJobs();
    let release!: () => void;
    jobs.track("health", new Promise<void>((resolve) => { release = resolve; }));
    let fail!: (e: Error) => void;
    const failing = new Promise<void>((_, reject) => { fail = reject; });
    failing.catch(() => undefined);
    jobs.track("monitor", failing);
    assert.deepEqual(jobs.names(), ["health", "monitor"]);
    fail(new Error("boom"));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(jobs.names(), ["health"]);
    release();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(jobs.names(), []);
  });

  it("counts overlapping runs of the same job", async () => {
    const jobs = new ActiveJobs();
    let a!: () => void;
    let b!: () => void;
    jobs.track("scan", new Promise<void>((r) => { a = r; }));
    jobs.track("scan", new Promise<void>((r) => { b = r; }));
    a();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(jobs.names(), ["scan"]);
    b();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(jobs.names(), []);
  });

  it("safeToDeploy needs drain on AND nothing running", () => {
    assert.deepEqual(deploySafety({ draining: false, activeJobs: [] }), {
      idleNow: true,
      safeToDeploy: false,
      activeJobs: [],
    });
    assert.equal(
      deploySafety({ draining: true, activeJobs: ["health"] }).safeToDeploy,
      false,
    );
    assert.equal(
      deploySafety({ draining: true, activeJobs: ["health"] }).idleNow,
      false,
    );
    assert.equal(
      deploySafety({ draining: true, activeJobs: [] }).safeToDeploy,
      true,
    );
    assert.deepEqual(
      deploySafety({ draining: true, activeJobs: ["b", "a", "a"] }).activeJobs,
      ["a", "b"],
    );
  });
});
