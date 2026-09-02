import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MONITOR_CYCLE_MS,
  MONITOR_LOOP_STAGES,
  isMonitorStageFresh,
  monitorNeedsResume,
  staleMonitorStages,
} from "./monitorResume.js";

describe("D167 monitor resume", () => {
  const now = Date.parse("2026-09-02T14:15:00.000Z");

  it("treats a missing or unreadable lastOk as stale", () => {
    assert.equal(isMonitorStageFresh(null, now), false);
    assert.equal(isMonitorStageFresh(undefined, now), false);
    assert.equal(isMonitorStageFresh("not-a-date", now), false);
  });

  it("skips a stage whose lastOk is still inside the 6h cycle", () => {
    assert.equal(
      isMonitorStageFresh("2026-09-02T14:00:47.000Z", now),
      true,
      "campaign-audit finished 14 minutes ago — resume must not rerun it",
    );
    assert.equal(
      isMonitorStageFresh("2026-09-02T08:15:00.000Z", now),
      true,
      "exactly 6h ago is still fresh (inclusive)",
    );
  });

  it("re-runs a stage whose lastOk is older than the cycle (the SIGTERM leftover)", () => {
    assert.equal(
      isMonitorStageFresh("2026-09-02T06:32:00.000Z", now),
      false,
      "sending-infra lastOk stuck at the morning pass must resume",
    );
  });

  it("names only the leftover tail after a mid-chain kill", () => {
    // Production 2026-09-02: morning lastOk 06:26–06:34; manual kick
    // recorded campaign-audit ~14:00 and lead-runout ~14:02; SIGTERM
    // during/after sending-infra left the rest at morning.
    const stageHealth = {
      "pod-tags": { lastOkAt: "2026-09-02T12:02:00.000Z" },
      "monitor-results": { lastOkAt: "2026-09-02T12:08:00.000Z" },
      "test-reconcile": { lastOkAt: "2026-09-02T12:10:00.000Z" },
      "dns-audit": { lastOkAt: "2026-09-02T12:12:00.000Z" },
      "campaign-audit": { lastOkAt: "2026-09-02T14:00:47.000Z" },
      "lead-runout": { lastOkAt: "2026-09-02T14:02:02.000Z" },
      "sending-infra": { lastOkAt: "2026-09-02T06:32:00.000Z" },
      "pod-controls": { lastOkAt: "2026-09-02T06:33:00.000Z" },
      "domain-client-audit": { lastOkAt: "2026-09-02T06:33:30.000Z" },
      "domain-lifecycle": { lastOkAt: "2026-09-02T06:33:40.000Z" },
      "isolation-buy-resume": { lastOkAt: "2026-09-02T06:33:50.000Z" },
      "canary-buy-resume": { lastOkAt: "2026-09-02T06:34:00.000Z" },
      "canary-adopt": { lastOkAt: "2026-09-02T06:34:10.000Z" },
      "isolation-rig": { lastOkAt: "2026-09-02T06:34:20.000Z" },
      "copy-isolation": { lastOkAt: "2026-09-02T06:34:30.000Z" },
    };
    assert.deepEqual(staleMonitorStages(stageHealth, now), [
      "sending-infra",
      "pod-controls",
      "domain-client-audit",
      "domain-lifecycle",
      "isolation-buy-resume",
      "canary-buy-resume",
      "canary-adopt",
      "isolation-rig",
      "copy-isolation",
    ]);
    assert.equal(monitorNeedsResume(stageHealth, now), true);
  });

  it("does not resume when every monitor stage is still fresh", () => {
    const fresh = Object.fromEntries(
      MONITOR_LOOP_STAGES.map((name) => [
        name,
        { lastOkAt: "2026-09-02T12:05:00.000Z" },
      ]),
    );
    assert.deepEqual(staleMonitorStages(fresh, now), []);
    assert.equal(monitorNeedsResume(fresh, now), false);
  });

  it("cycle window is 6 hours, not the 6h45m overdue grace", () => {
    assert.equal(MONITOR_CYCLE_MS, 6 * 60 * 60 * 1000);
  });

  it("every monitor-loop stage has a D131 overdue window", async () => {
    const { STAGE_OVERDUE_WINDOWS_MS } = await import("./stageWindows.js");
    for (const name of MONITOR_LOOP_STAGES) {
      assert.equal(
        typeof STAGE_OVERDUE_WINDOWS_MS[name],
        "number",
        `${name} must stay in STAGE_OVERDUE_WINDOWS_MS or D149 cannot page it`,
      );
    }
  });
});
