import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { pruneStateLedgers, STATE_RETENTION } from "./stateRetention.js";

describe("D257 state retention prune", () => {
  it("drops old ledgers and caps finding history", async () => {
    const state = new StateStore(
      `/tmp/dw-prune-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const now = Date.parse("2026-10-12T20:00:00.000Z");
    const old = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

    const snap = state.get();
    snap.alertedKeys.old = old;
    snap.alertedKeys.fresh = recent;
    snap.remediatedKeys.old = old;
    snap.resurrectedLeads["1:old@x.com"] = old;
    snap.resurrectedLeads["1:new@x.com"] = recent;
    snap.bounceSnapshots["1"] = { bounced: 1, sent: 10, at: old };
    snap.bounceSnapshots["2"] = { bounced: 0, sent: 4, at: recent };
    snap.terlPausedDays["2026-08-01"] = {
      ymd: "2026-08-01",
      postedAt: null,
      inboxes: [],
    };
    snap.terlPausedDays["2026-10-11"] = {
      ymd: "2026-10-11",
      postedAt: null,
      inboxes: [],
    };
    snap.isolation.mailboxResults["a@x.com"] = {
      email: "a@x.com",
      ranAt: recent,
      placement: "PRIMARY",
      history: Array.from({ length: 20 }, () => "PRIMARY" as const),
      rollingFailCount: 0,
      tag: "keep",
    };
    snap.isolation.domainHistory["x.com"] = {
      domain: "x.com",
      fleet: false,
      consecutiveFails: 0,
      status: "ok",
      readings: Array.from({ length: 20 }, (_, i) => ({
        at: recent,
        domainFailed: false,
        failingEmails: [],
        testedEmails: [`${i}@x.com`],
      })),
    };
    snap.isolation.runs.oldrun = {
      id: "oldrun",
      campaignId: 1,
      startedAt: old,
      updatedAt: old,
      control: "CLEAN",
      verdict: "HEALTHY",
      campaignInSpam: false,
      reason: "old",
    };
    snap.isolation.actions.done = {
      id: "done",
      kind: "swap_copy",
      status: "executed",
      title: "old",
      proof: "old",
      detail: {},
      allowed: "owner",
      requestedAt: old,
      executedAt: old,
    };
    snap.isolation.actions.live = {
      id: "live",
      kind: "retire_domain",
      status: "pending",
      title: "keep",
      proof: "keep",
      detail: {},
      allowed: "owner",
      requestedAt: old,
    };

    const stats = pruneStateLedgers(snap, now);
    assert.ok(stats.dropped > 0);
    assert.equal(snap.alertedKeys.old, undefined);
    assert.equal(snap.alertedKeys.fresh, recent);
    assert.equal(snap.resurrectedLeads["1:old@x.com"], undefined);
    assert.equal(snap.resurrectedLeads["1:new@x.com"], recent);
    assert.equal(snap.bounceSnapshots["1"], undefined);
    assert.ok(snap.bounceSnapshots["2"]);
    assert.equal(snap.terlPausedDays["2026-08-01"], undefined);
    assert.ok(snap.terlPausedDays["2026-10-11"]);
    assert.equal(
      snap.isolation.mailboxResults["a@x.com"]?.history.length,
      STATE_RETENTION.mailboxHistoryCap,
    );
    assert.equal(
      snap.isolation.domainHistory["x.com"]?.readings.length,
      STATE_RETENTION.domainReadingsCap,
    );
    assert.equal(snap.isolation.runs.oldrun, undefined);
    assert.equal(snap.isolation.actions.done, undefined);
    assert.equal(snap.isolation.actions.live?.status, "pending");
  });
});
