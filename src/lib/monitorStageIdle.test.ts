/**
 * D336 — disabled / testing-off monitor stages stamp lastOk +
 * lastSkipReason every sitting, so they stop being D167 leftovers and the
 * 15-minute resume storm ends; the canary-adopt boot kick does not run
 * while testing is off.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  monitorStageIdleReason,
  runOrIdleStage,
  shouldBootKickCanaryAdopt,
} from "./monitorStageIdle.js";
import { MONITOR_LOOP_STAGES, staleMonitorStages } from "./monitorResume.js";
import { runStampedStage } from "./stageStamp.js";
import { stageIdleReason, type StageHealthRow } from "./stageWindows.js";

const POD_GATED = [
  "pod-tags",
  "pod-controls",
  "domain-client-audit",
  "domain-lifecycle",
  "isolation-buy-resume",
] as const;
const TESTING_GATED = [
  "canary-buy-resume",
  "canary-adopt",
  "isolation-rig",
  "copy-isolation",
] as const;

describe("D336 monitor stage idle reason", () => {
  it("disabled flag idles as disabled; testing-gated stages idle as testing-off first", () => {
    assert.equal(
      monitorStageIdleReason({ enabled: false, testingEnabled: false }),
      "disabled",
    );
    assert.equal(
      monitorStageIdleReason({ enabled: true, testingEnabled: false }),
      null,
    );
    assert.equal(
      monitorStageIdleReason({ enabled: true, testingGated: true, testingEnabled: false }),
      "testing-off",
    );
    assert.equal(
      monitorStageIdleReason({ enabled: false, testingGated: true, testingEnabled: false }),
      "testing-off",
    );
    assert.equal(
      monitorStageIdleReason({ enabled: false, testingGated: true, testingEnabled: true }),
      "disabled",
    );
    assert.equal(
      monitorStageIdleReason({ enabled: true, testingGated: true, testingEnabled: true }),
      null,
    );
  });

  it("an idle body never calls the real run (no Smartlead calls)", async () => {
    let calls = 0;
    const body = runOrIdleStage("canary-adopt", "testing-off", async () => {
      calls += 1;
      return "ran";
    });
    assert.deepEqual(await body(), { skipped: true, reason: "testing-off" });
    assert.equal(calls, 0);
    const live = runOrIdleStage("canary-adopt", null, async () => {
      calls += 1;
      return "ran";
    });
    assert.equal(await live(), "ran");
    assert.equal(calls, 1);
  });

  it("ENABLE_POD_CONTROLS off + testing off: every gated stage stamps lastOk + lastSkipReason and is no longer a leftover", async () => {
    const now = Date.parse("2026-11-12T19:00:00.000Z");
    const old = "2026-11-09T02:18:04.419Z";
    const health: Record<string, StageHealthRow> = {};
    // Every non-gated monitor stage is fresh; the gated tail is stale (prod 11/12).
    for (const name of MONITOR_LOOP_STAGES) {
      health[name] = { lastOkAt: new Date(now - 60_000).toISOString(), consecutiveFailures: 0, lastError: null };
    }
    for (const name of [...POD_GATED, ...TESTING_GATED]) {
      health[name] = { lastOkAt: old, consecutiveFailures: name === "canary-adopt" ? 64 : 0, lastError: null };
    }
    assert.deepEqual(
      staleMonitorStages(health, now).sort(),
      [...POD_GATED, ...TESTING_GATED].sort(),
    );

    const smartleadCalls: string[] = [];
    for (const name of [...POD_GATED, ...TESTING_GATED]) {
      const idle = monitorStageIdleReason({
        enabled: false,
        testingGated: (TESTING_GATED as readonly string[]).includes(name),
        testingEnabled: false,
      });
      await runStampedStage({
        name,
        startedAt: now,
        run: () =>
          runOrIdleStage(name, idle, async () => {
            smartleadCalls.push(name);
            return null;
          })(),
        idleReason: stageIdleReason,
        recordOk: (stage, durationMs, skipReason) => {
          health[stage] = {
            lastOkAt: new Date(now).toISOString(),
            consecutiveFailures: 0,
            lastError: null,
            lastSkipReason: skipReason ?? null,
            lastDurationMs: durationMs,
          };
        },
        recordError: (stage, message) => {
          assert.fail(`${stage} should not fail: ${message}`);
        },
        checkpoint: async () => {},
      });
    }
    assert.deepEqual(smartleadCalls, []);
    for (const name of POD_GATED) {
      assert.equal(health[name].lastSkipReason, "disabled", name);
      assert.equal(health[name].lastOkAt, new Date(now).toISOString(), name);
    }
    for (const name of TESTING_GATED) {
      assert.equal(health[name].lastSkipReason, "testing-off", name);
    }
    assert.equal(health["canary-adopt"].consecutiveFailures, 0);
    assert.deepEqual(staleMonitorStages(health, now + 60_000), []);
  });
});

describe("D336 canary-adopt boot kick", () => {
  it("does not run while testing is off", () => {
    assert.equal(shouldBootKickCanaryAdopt({ secretsReady: true, testingEnabled: false }), false);
    assert.equal(shouldBootKickCanaryAdopt({ secretsReady: false, testingEnabled: true }), false);
    assert.equal(shouldBootKickCanaryAdopt({ secretsReady: true, testingEnabled: true }), true);
  });

  it("index.ts schedules the 90s kick only behind shouldBootKickCanaryAdopt", async () => {
    const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    const kick = index.indexOf("}, 90_000);");
    assert.ok(kick > 0, "90s canary-adopt boot kick moved");
    const gate = index.lastIndexOf("shouldBootKickCanaryAdopt({", kick);
    assert.ok(gate > 0 && kick - gate < 600, "boot kick is not gated on testing (D336)");
  });

  it("runMonitor stamps every gated stage instead of hiding it behind an enable flag", async () => {
    const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    const start = index.indexOf("const runMonitor = async");
    const end = index.indexOf("monitorInFlight = run.finally", start);
    const body = index.slice(start, end);
    assert.doesNotMatch(body, /if \(config\.enablePodControls\)/);
    assert.doesNotMatch(body, /if \(config\.enableIsolationRig\)/);
    assert.doesNotMatch(body, /if \(config\.enableCopyIsolation\)/);
    for (const name of [
      ...POD_GATED,
      ...TESTING_GATED,
      "warmup-gate-monitor",
      "test-reconcile",
      "lead-runout",
      "sending-infra",
    ]) {
      assert.match(
        body,
        new RegExp(`stage\\("${name}", runOrIdleStage\\("${name}",`),
        `${name} is not stamped when idle (D336)`,
      );
    }
  });
});
