import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { alertCanonMisses, alertStageAnomalies, stageAlertText } from "./opsAlerts.js";

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

describe("D163 — CANON misses page Slack, once per campaign per incident", () => {
  async function seeded() {
    const s = store();
    await s.load();
    s.recordPlacementScore({
      campaignId: 3847794,
      campaignName: "TechEvo SFL Startup Owners AirPods",
      testId: "526826",
      source: "canary-copy",
      inboxPercent: 0,
      at: "2026-09-02T04:00:00.000Z",
    });
    return s;
  }

  it("pages an ugly canary once, then stays silent on the next sweep", async () => {
    const s = await seeded();
    const r = recorder();
    const first = await alertCanonMisses({ store: s, slack: r.slack, threshold: 80 });
    assert.deepEqual(first.alerted, ["3847794:ugly"]);
    assert.equal(r.sends.length, 1);
    assert.equal(r.sends[0].kind, "ops_alert");
    assert.match(r.sends[0].text, /CANON miss/);
    assert.match(r.sends[0].text, /TechEvo/);

    const second = await alertCanonMisses({ store: s, slack: r.slack, threshold: 80 });
    assert.deepEqual(second.alerted, []);
    assert.equal(r.sends.length, 1, "one page per incident, not one per 15m");
  });

  it("pages again when isolation evaluates INCONCLUSIVE (transition)", async () => {
    const s = await seeded();
    const r = recorder();
    await alertCanonMisses({ store: s, slack: r.slack, threshold: 80 });
    s.upsertIsolationRun({
      id: "run-1",
      campaignId: 3847794,
      campaignName: "TechEvo SFL Startup Owners AirPods",
      startedAt: "2026-09-02T04:10:00.000Z",
      updatedAt: "2026-09-02T04:10:00.000Z",
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason: "need another reading",
    });
    const next = await alertCanonMisses({ store: s, slack: r.slack, threshold: 80 });
    assert.deepEqual(next.alerted, ["3847794:INCONCLUSIVE"]);
    assert.equal(r.sends.length, 2);
    assert.match(r.sends[1].text, /INCONCLUSIVE/);
  });

  it("clears the stamp when inbox recovers so a later miss can page", async () => {
    const s = await seeded();
    const r = recorder();
    await alertCanonMisses({ store: s, slack: r.slack, threshold: 80 });
    s.recordPlacementScore({
      campaignId: 3847794,
      campaignName: "TechEvo SFL Startup Owners AirPods",
      testId: "526826",
      source: "canary-copy",
      inboxPercent: 92,
      at: "2026-09-02T05:00:00.000Z",
    });
    const rec = await alertCanonMisses({ store: s, slack: r.slack, threshold: 80 });
    assert.deepEqual(rec.recovered, [3847794]);
    assert.equal(s.getCanonMissAlert(3847794), undefined);
    assert.equal(r.sends.length, 1, "recovery is silent");
  });

  it("does not page stale INCONCLUSIVE on any COMPLETED sibling (D165)", async () => {
    const s = store();
    await s.load();
    const reason =
      "No standing inbox-test reading for the mailboxes this campaign is sending from.";
    for (const row of [
      {
        id: 3763805,
        name: "BCP Logistics Over-1k (With Team)",
      },
      {
        id: 3763806,
        name: "BCP Logistics Over-1k (No Team)",
      },
    ]) {
      s.upsertIsolationRun({
        id: `stale-${row.id}`,
        campaignId: row.id,
        campaignName: row.name,
        startedAt: "2026-08-24T12:00:00.000Z",
        updatedAt: "2026-08-24T12:00:00.000Z",
        control: "INSUFFICIENT",
        verdict: "INCONCLUSIVE",
        campaignInSpam: true,
        reason,
      });
      s.setCanonMissAlert(row.id, "INCONCLUSIVE");
    }
    s.upsertIsolationRun({
      id: "run-active",
      campaignId: 3847794,
      campaignName: "TechEvo SFL Startup Owners AirPods",
      startedAt: "2026-09-02T04:10:00.000Z",
      updatedAt: "2026-09-02T04:10:00.000Z",
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason: "need another reading",
    });
    const r = recorder();
    const out = await alertCanonMisses({
      store: s,
      slack: r.slack,
      threshold: 80,
      campaigns: [
        { id: 3763805, status: "COMPLETED" },
        { id: 3763806, status: "COMPLETED" },
        { id: 3847794, status: "ACTIVE" },
      ],
    });
    assert.deepEqual(
      out.alerted,
      ["3847794:INCONCLUSIVE"],
      "skip is by ACTIVE status — both BCP siblings stay quiet",
    );
    assert.equal(r.sends.length, 1);
    assert.match(r.sends[0].text, /INCONCLUSIVE/);
    assert.match(r.sends[0].text, /#3847794/);
    assert.deepEqual(out.recovered.sort(), [3763805, 3763806]);
    assert.equal(s.getCanonMissAlert(3763805), undefined);
    assert.equal(s.getCanonMissAlert(3763806), undefined);
    assert.equal(s.getCanonMissAlert(3847794), "INCONCLUSIVE");
  });

  it("does not page a fresh INCONCLUSIVE on PAUSED (D165)", async () => {
    const s = store();
    await s.load();
    s.upsertIsolationRun({
      id: "paused-run",
      campaignId: 11,
      campaignName: "Paused leftover",
      startedAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:00.000Z",
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason: "need another reading",
    });
    const r = recorder();
    const out = await alertCanonMisses({
      store: s,
      slack: r.slack,
      threshold: 80,
      campaigns: [{ id: 11, status: "PAUSED" }],
    });
    assert.deepEqual(out.alerted, []);
    assert.equal(r.sends.length, 0);
  });

  it("still pages INCONCLUSIVE on an ACTIVE campaign (D165)", async () => {
    const s = await seeded();
    const r = recorder();
    s.upsertIsolationRun({
      id: "run-active",
      campaignId: 3847794,
      campaignName: "TechEvo SFL Startup Owners AirPods",
      startedAt: "2026-09-02T04:10:00.000Z",
      updatedAt: "2026-09-02T04:10:00.000Z",
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason: "need another reading",
    });
    const out = await alertCanonMisses({
      store: s,
      slack: r.slack,
      threshold: 80,
      campaigns: [{ id: 3847794, status: "ACTIVE" }],
    });
    assert.deepEqual(out.alerted, ["3847794:INCONCLUSIVE"]);
    assert.equal(r.sends.length, 1);
    assert.match(r.sends[0].text, /INCONCLUSIVE/);
  });

  it("pages a first-open core checklist hole once", async () => {
    const s = store();
    await s.load();
    s.upsertCampaignCheck({
      campaignId: 3847794,
      name: "TechEvo SFL Startup Owners AirPods",
      firstSeenAt: "2026-09-01T00:00:00.000Z",
      firstCheckAt: "2026-09-01T00:00:00.000Z",
      firstPassedAt: null,
      lastSweepAt: "2026-09-02T04:00:00.000Z",
      lastKind: "hourly",
      findings: ["missing_canary: none"],
    });
    const r = recorder();
    const first = await alertCanonMisses({ store: s, slack: r.slack, threshold: 80 });
    assert.ok(first.alerted.includes("3847794:findings"));
    assert.equal(r.sends.length, 1);
    assert.match(r.sends[0].text, /not sending healthy/);
    assert.match(r.sends[0].text, /no canary/);
    const second = await alertCanonMisses({ store: s, slack: r.slack, threshold: 80 });
    assert.equal(second.alerted.includes("3847794:findings"), false);
    assert.equal(r.sends.length, 1);
  });

  it("dry-run pages nothing and stamps nothing", async () => {
    const s = await seeded();
    const r = recorder();
    const out = await alertCanonMisses({
      store: s,
      slack: r.slack,
      threshold: 80,
      dryRun: true,
    });
    assert.deepEqual(out, { alerted: [], recovered: [] });
    assert.equal(r.sends.length, 0);
    assert.equal(s.getCanonMissAlert(3847794), undefined);
  });
});
