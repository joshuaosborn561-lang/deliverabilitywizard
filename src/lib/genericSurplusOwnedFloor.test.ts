import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardSurplusByOwnedFloor } from "./genericSurplusReturn.js";

const owned = (o: number, floor = 40, generics = o) => ({ owned: o, floor, generics });

describe("D298 surplus return respects per-POD owned floor", () => {
  it("holds every return from a POD already under floor", () => {
    const picks = [1, 2, 3].map((i) => ({ email: `g${i}@x.test`, clientId: 7, pod: "B" }));
    const r = guardSurplusByOwnedFloor({
      picks,
      ownedByClientPod: new Map([["7:B", owned(31.6)]]),
      weightByEmail: new Map(picks.map((p) => [p.email, 1])),
    });
    assert.equal(r.kept.length, 0);
    assert.equal(r.held.length, 3);
  });

  it("returns only the true surplus above floor, counted per POD", () => {
    const picks = [1, 2, 3].map((i) => ({ email: `g${i}@x.test`, clientId: 7, pod: "A" }));
    const r = guardSurplusByOwnedFloor({
      picks,
      ownedByClientPod: new Map([["7:A", owned(42)], ["7:B", owned(20)]]),
      weightByEmail: new Map(picks.map((p) => [p.email, 1])),
    });
    assert.deepEqual(r.kept.map((p) => p.email), ["g1@x.test", "g2@x.test"]);
    assert.deepEqual(r.held.map((p) => p.email), ["g3@x.test"]);
  });

  it("does not guard clients without an active campaign or unpodded seats", () => {
    const picks = [
      { email: "a@x.test", clientId: 8, pod: "A" },
      { email: "b@x.test", clientId: 7, pod: null },
    ];
    const r = guardSurplusByOwnedFloor({
      picks,
      ownedByClientPod: new Map([["8:A", owned(0)]]),
      weightByEmail: new Map([["a@x.test", 1], ["b@x.test", 1]]),
      clientHasActiveCampaign: new Map([[8, false]]),
    });
    assert.equal(r.kept.length, 2);
  });

  it("a generic min40 does not count cannot drop the POD", () => {
    const picks = [{ email: "x@x.test", clientId: 7, pod: "A" }];
    const r = guardSurplusByOwnedFloor({
      picks,
      ownedByClientPod: new Map([["7:A", owned(40, 40, 0)]]),
      weightByEmail: new Map([["x@x.test", 1]]),
    });
    assert.equal(r.kept.length, 1);
  });

  it("live shape: POD-B 24 named + 7.6 generics never returns a POD-B generic", () => {
    const picks = Array.from({ length: 16 }, (_, i) => ({ email: `b${i}@x.test`, clientId: 7, pod: "B" }));
    const r = guardSurplusByOwnedFloor({
      picks,
      ownedByClientPod: new Map([["7:B", owned(31.6, 40, 7.6)]]),
      weightByEmail: new Map(picks.map((p) => [p.email, 1])),
    });
    assert.equal(r.kept.length, 0);
  });
});
