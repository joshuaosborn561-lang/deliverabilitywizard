import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isOverdueCanonOpsExclusive,
  isPausedForHealth,
  isSlackInteractionExclusive,
  PausedForHealthError,
  pauseWhileHealthLive,
  pauseWhileOverdueCanonOps,
  pauseWhileSlackInteraction,
  setOverdueCanonOpsExclusive,
  setSlackInteractionExclusive,
} from "./healthCpuPause.js";

describe("D272 pauseWhileHealthLive", () => {
  it("returns immediately when health is not live", async () => {
    const started = Date.now();
    await pauseWhileHealthLive(() => false);
    assert.ok(Date.now() - started < 20);
  });

  it("waits until health ends, then continues", async () => {
    let live = true;
    setTimeout(() => {
      live = false;
    }, 40);
    const started = Date.now();
    await pauseWhileHealthLive(() => live, { label: "campaign-audit" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 30, `expected to wait ~40ms, waited ${elapsed}ms`);
    assert.equal(live, false);
  });

  it("is a no-op when pauseWhile is omitted", async () => {
    const started = Date.now();
    await pauseWhileHealthLive(undefined);
    assert.ok(Date.now() - started < 20);
  });

  it("D293: health CPU waits while overdue canon-ops is exclusive", async () => {
    setOverdueCanonOpsExclusive(true);
    assert.equal(isOverdueCanonOpsExclusive(), true);
    setTimeout(() => setOverdueCanonOpsExclusive(false), 40);
    const started = Date.now();
    await pauseWhileOverdueCanonOps({ label: "health:client-rest" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 30, `expected to wait ~40ms, waited ${elapsed}ms`);
    assert.equal(isOverdueCanonOpsExclusive(), false);
  });

  it("D293: min40 walks skip the overdue pause", async () => {
    setOverdueCanonOpsExclusive(true);
    const started = Date.now();
    await pauseWhileOverdueCanonOps({ skip: true });
    assert.ok(Date.now() - started < 20);
    setOverdueCanonOpsExclusive(false);
  });

  it("D294: fleet scans wait while a Slack tap is exclusive", async () => {
    setSlackInteractionExclusive(true);
    assert.equal(isSlackInteractionExclusive(), true);
    setTimeout(() => setSlackInteractionExclusive(false), 40);
    const started = Date.now();
    await pauseWhileSlackInteraction({ label: "scan:indexAccountsByCampaign" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 30, `expected to wait ~40ms, waited ${elapsed}ms`);
    assert.equal(isSlackInteractionExclusive(), false);
  });
});

describe("D336 pauseWhileHealthLive abort + exit", () => {
  it("stops waiting when the stage signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("timeout after 10m")), 40);
    const started = Date.now();
    await assert.rejects(
      pauseWhileHealthLive(() => true, { signal: controller.signal }),
      /timeout after 10m/,
    );
    assert.ok(Date.now() - started < 1_000, "kept waiting after abort");
  });

  it("an already-aborted signal throws even when health is not live", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pauseWhileHealthLive(() => false, { signal: controller.signal }));
    await assert.rejects(pauseWhileHealthLive(undefined, { signal: controller.signal }));
  });

  it("exitOnLive throws the PausedForHealth sentinel instead of waiting", async () => {
    const started = Date.now();
    await assert.rejects(
      pauseWhileHealthLive(() => true, { exitOnLive: true }),
      (error: unknown) => isPausedForHealth(error) && error instanceof PausedForHealthError,
    );
    assert.ok(Date.now() - started < 20);
    await pauseWhileHealthLive(() => false, { exitOnLive: true });
    assert.equal(isPausedForHealth(new Error("timeout after 10m")), false);
  });
});
