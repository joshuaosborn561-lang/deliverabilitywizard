import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pauseWhileHealthLive } from "./healthCpuPause.js";

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
});
