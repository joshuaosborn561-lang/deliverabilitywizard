import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HEALTH_CYCLE_MS,
  HEALTH_LOOP_STAGES,
  HEALTH_TAIL_STAGES,
  healthNeedsResume,
  staleHealthStages,
  staleHealthTail,
} from "./healthResume.js";

describe("D211 health resume", () => {
  // Production 2026-09-30: D210 deploy ~14:16 killed the sitting after
  // campaign-health. mailbox-gap lastOk stayed 12:12Z, failures=0.
  const now = Date.parse("2026-09-30T14:30:00.000Z");

  it("names the leftover tail after a mid-chain deploy kill", () => {
    const stageHealth = {
      inventory: { lastOkAt: "2026-09-30T14:15:19.000Z" },
      "client-rest": { lastOkAt: "2026-09-30T13:47:14.000Z" },
      "generic-rest": { lastOkAt: "2026-09-30T13:47:19.000Z" },
      "client-tag": { lastOkAt: "2026-09-30T14:15:20.000Z" },
      "one-client": { lastOkAt: "2026-09-30T14:15:20.000Z" },
      "qa-unpause": { lastOkAt: "2026-09-30T14:15:20.000Z" },
      "campaign-check-first": { lastOkAt: "2026-09-30T14:15:20.000Z" },
      "warmup-gate": { lastOkAt: "2026-09-30T14:08:36.000Z" },
      "campaign-health": { lastOkAt: "2026-09-30T14:15:21.000Z" },
      "pod-cover": { lastOkAt: "2026-09-30T13:13:51.000Z" },
      reconnect: { lastOkAt: "2026-09-30T13:19:43.000Z" },
      "mailbox-gap": { lastOkAt: "2026-09-30T12:12:53.000Z" },
      "isolation-branch": { lastOkAt: "2026-09-30T12:16:56.000Z" },
      "isolation-buy-resume": { lastOkAt: "2026-09-30T12:21:47.000Z" },
    };
    assert.deepEqual(staleHealthTail(stageHealth, now), [
      "pod-cover",
      "reconnect",
      "mailbox-gap",
      "isolation-branch",
      "isolation-buy-resume",
    ]);
    assert.equal(healthNeedsResume(stageHealth, now), true);
    assert.ok(
      staleHealthStages(stageHealth, now).includes("mailbox-gap"),
      "mailbox-gap must be in the leftover list so skip-if-fresh does not skip it",
    );
  });

  it("does not resume when every health stage is still fresh", () => {
    const fresh = Object.fromEntries(
      HEALTH_LOOP_STAGES.map((name) => [
        name,
        { lastOkAt: "2026-09-30T14:20:00.000Z" },
      ]),
    );
    assert.deepEqual(staleHealthTail(fresh, now), []);
    assert.equal(healthNeedsResume(fresh, now), false);
  });

  it("does not resume when the whole board is stale (normal 15m tick)", () => {
    const stale = Object.fromEntries(
      HEALTH_LOOP_STAGES.map((name) => [
        name,
        { lastOkAt: "2026-09-30T12:12:00.000Z" },
      ]),
    );
    assert.equal(healthNeedsResume(stale, now), false);
    assert.deepEqual(staleHealthStages(stale, now), [...HEALTH_LOOP_STAGES]);
  });

  it("cycle window is 15 minutes, not the 45m overdue grace", () => {
    assert.equal(HEALTH_CYCLE_MS, 15 * 60 * 1000);
  });

  it("every health-loop stage has a D131 overdue window", async () => {
    const { STAGE_OVERDUE_WINDOWS_MS } = await import("./stageWindows.js");
    for (const name of HEALTH_LOOP_STAGES) {
      assert.equal(
        typeof STAGE_OVERDUE_WINDOWS_MS[name],
        "number",
        `${name} must stay in STAGE_OVERDUE_WINDOWS_MS or D149 cannot page it`,
      );
    }
    for (const name of HEALTH_TAIL_STAGES) {
      assert.ok(
        HEALTH_LOOP_STAGES.includes(name),
        `${name} tail stage must stay on HEALTH_LOOP_STAGES`,
      );
    }
  });
});
