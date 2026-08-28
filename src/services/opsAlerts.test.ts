import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { alertStageAnomalies, stageAlertText } from "./opsAlerts.js";

function store(): StateStore {
  return new StateStore(
    `/tmp/dw-opsalerts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

function recorder() {
  const sends: { text: string; kind?: string }[] = [];
  return {
    sends,
    slack: {
      send: async (text: string, _blocks?: unknown[], kind?: string) => {
        sends.push({ text, kind });
      },
    },
  };
}

describe("D149 — the stage watchdog pages Slack, once per episode", () => {
  it("pages a newly overdue stage once, then stays silent while the episode lasts", async () => {
    const s = store();
    s.recordStageOk("dns-audit", 1000);
    const later = Date.now() + 8 * 3600 * 1000; // 8h > the 6h45m window
    const r = recorder();

    const first = await alertStageAnomalies({ store: s, slack: r.slack, now: later });
    assert.deepEqual(first.alerted, ["dns-audit"]);
    assert.equal(r.sends.length, 1);
    assert.equal(r.sends[0].kind, "ops_alert");
    assert.match(r.sends[0].text, /dns-audit/);
    assert.match(r.sends[0].text, /overdue/);

    const second = await alertStageAnomalies({
      store: s,
      slack: r.slack,
      now: later + 15 * 60 * 1000,
    });
    assert.deepEqual(second.alerted, []);
    assert.equal(r.sends.length, 1, "one page per episode, not one per pass");
  });

  it("posts one recovery note when the stage comes back, then goes quiet", async () => {
    const s = store();
    s.recordStageOk("dns-audit", 1000);
    const later = Date.now() + 8 * 3600 * 1000;
    const r = recorder();
    await alertStageAnomalies({ store: s, slack: r.slack, now: later });
    assert.equal(r.sends.length, 1);

    // The stage succeeds again (lastOkAt = real now → fresh vs real now).
    s.recordStageOk("dns-audit", 900);
    const rec = await alertStageAnomalies({ store: s, slack: r.slack, now: Date.now() });
    assert.deepEqual(rec.recovered, ["dns-audit"]);
    assert.equal(r.sends.length, 2);
    assert.match(r.sends[1].text, /recovered/);
    assert.equal(Object.keys(s.listStageAlerts()).length, 0, "episode cleared");

    const idle = await alertStageAnomalies({ store: s, slack: r.slack, now: Date.now() });
    assert.deepEqual(idle.recovered, []);
    assert.deepEqual(idle.alerted, []);
    assert.equal(r.sends.length, 2);
  });

  it("a failed page is retried next pass instead of going silent", async () => {
    const s = store();
    s.recordStageError("dns-audit", "HTTP 429"); // never succeeded → overdue now
    const sends: string[] = [];
    let broken = true;
    const slack = {
      send: async (text: string) => {
        if (broken) throw new Error("slack down");
        sends.push(text);
      },
    };

    const first = await alertStageAnomalies({ store: s, slack, now: Date.now() });
    assert.deepEqual(first.alerted, []);
    assert.equal(
      Object.keys(s.listStageAlerts()).length,
      0,
      "no episode stamp on a failed page",
    );

    broken = false;
    const second = await alertStageAnomalies({ store: s, slack, now: Date.now() });
    assert.deepEqual(second.alerted, ["dns-audit"]);
    assert.equal(sends.length, 1);
  });

  it("an event-driven stage (null window) never pages", async () => {
    const s = store();
    s.recordStageError("pod-cover", "boom");
    const r = recorder();
    const out = await alertStageAnomalies({
      store: s,
      slack: r.slack,
      now: Date.now() + 30 * 24 * 3600 * 1000,
    });
    assert.deepEqual(out.alerted, []);
    assert.equal(r.sends.length, 0);
  });

  it("dry-run pages nothing and stamps nothing", async () => {
    const s = store();
    s.recordStageError("dns-audit", "HTTP 429");
    const r = recorder();
    const out = await alertStageAnomalies({
      store: s,
      slack: r.slack,
      dryRun: true,
      now: Date.now(),
    });
    assert.deepEqual(out, { alerted: [], recovered: [] });
    assert.equal(r.sends.length, 0);
    assert.equal(Object.keys(s.listStageAlerts()).length, 0);
  });

  it("the D131 prune clears a dropped stage's episode stamp too", () => {
    const s = store();
    s.recordStageError("morning-activate", "ghost");
    s.setStageAlert("morning-activate", new Date().toISOString());
    s.dropStageHealth("morning-activate");
    assert.deepEqual(s.listStageAlerts(), {});
  });

  it("the page names the stage, its cadence, the failure count and the error", () => {
    const text = stageAlertText([
      {
        name: "dns-audit",
        lastOkAt: "2026-08-27T18:14:53.959Z",
        consecutiveFailures: 1,
        lastError: "HTTP 429",
        windowMs: (6 * 60 + 45) * 60 * 1000,
      },
    ]);
    assert.match(text, /dns-audit/);
    assert.match(text, /6h45m/);
    assert.match(text, /1 straight failure/);
    assert.match(text, /HTTP 429/);
  });
});
