import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { buildIsolationAction } from "../lib/isolationActions.js";
import { SpendDigestService } from "./spendDigest.js";

function tempStore(): StateStore {
  return new StateStore(
    `/tmp/dw-spend-digest-svc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

function mondayMorningCt(): Date {
  // Monday 2026-10-05 12:16 UTC = 07:16 America/Chicago (CDT).
  return new Date("2026-10-05T12:16:00.000Z");
}

function saturdayMorningCt(): Date {
  return new Date("2026-10-03T12:16:00.000Z");
}

describe("SpendDigestService (D220)", () => {
  it("posts one weekday digest and does not post again the same day", async () => {
    const store = tempStore();
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "retire_domain",
        title: "Retire boldercyperpartnerhub.info",
        proof: "AS(42004)",
        detail: {
          domain: "boldercyperpartnerhub.info",
          ownerKind: "client",
          ownerClientId: 542838,
          ownerClientName: "BCP",
        },
      }),
    );
    const sent: string[] = [];
    const service = new SpendDigestService(store, {
      send: async (text) => {
        sent.push(text);
        return undefined;
      },
    });
    const first = await service.postDigest({ now: mondayMorningCt() });
    assert.equal(first.posted, true);
    assert.equal(first.clients, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /one approval per client/);
    const second = await service.postDigest({ now: mondayMorningCt() });
    assert.equal(second.posted, false);
    assert.equal(second.reason, "already-posted");
    assert.equal(sent.length, 1);
  });

  it("stays silent on the weekend and when the queue is empty", async () => {
    const store = tempStore();
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "retire_domain",
        title: "Retire boldercyperpartnerhub.info",
        proof: "AS(42004)",
        detail: { domain: "boldercyperpartnerhub.info" },
      }),
    );
    const sent: string[] = [];
    const service = new SpendDigestService(store, {
      send: async (text) => {
        sent.push(text);
        return undefined;
      },
    });
    const weekend = await service.postDigest({ now: saturdayMorningCt() });
    assert.equal(weekend.posted, false);
    assert.match(String(weekend.reason), /weekday/);
    assert.equal(sent.length, 0);

    const emptyStore = tempStore();
    const empty = new SpendDigestService(emptyStore, {
      send: async (text) => {
        sent.push(text);
        return undefined;
      },
    });
    const none = await empty.postDigest({ now: mondayMorningCt() });
    assert.equal(none.posted, false);
    assert.equal(none.reason, "none");
    assert.equal(sent.length, 0);
  });
});
