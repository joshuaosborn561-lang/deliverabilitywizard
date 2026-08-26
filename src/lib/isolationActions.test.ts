import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlackClient } from "../clients/slack.js";
import { StateStore } from "../state/store.js";
import {
  buildIsolationAction,
  dismissPendingSignatureAsks,
  remindPendingIsolationActions,
  requestIsolationAction,
} from "./isolationActions.js";

function slackCapture() {
  const notified: string[] = [];
  const slack = {
    notifyIsolationAction: async (details: { actionId: string }) => {
      notified.push(details.actionId);
    },
  } as unknown as SlackClient;
  return { slack, notified };
}

function tempStore(): StateStore {
  return new StateStore(
    `/tmp/dw-iso-actions-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("isolation Slack reminds", () => {
  it("skips a second request for the same pending canary buy", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const action = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy canary fleet",
      proof: "Fleet is missing.",
      detail: {},
    });
    const first = await requestIsolationAction({ store, slack, action });
    const second = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "buy_canary_fleet",
        title: "Buy canary fleet",
        proof: "Still missing.",
        detail: {},
      }),
    });
    assert.ok(first);
    assert.equal(second, null);
    assert.deepEqual(notified, [action.id]);
  });

  it("D97: leftover Add %signature% asks are dismissed and never re-posted", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const leftover = buildIsolationAction({
      kind: "add_signature_tag",
      title: "%signature% missing on SalesGlider Nurture",
      proof: "#3122546 SalesGlider Nurture is blocked at QA",
      detail: { campaignId: 3122546 },
    });
    store.upsertIsolationAction(leftover);
    const dropped = dismissPendingSignatureAsks(store);
    const count = await remindPendingIsolationActions({ store, slack });
    assert.equal(dropped, 1);
    assert.equal(count, 0);
    assert.deepEqual(notified, []);
    assert.equal(store.pendingIsolationActions().length, 0);
  });

  it("re-posts pending buttons without creating a new ask", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const action = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy canary fleet",
      proof: "Fleet is missing.",
      detail: {},
    });
    await requestIsolationAction({ store, slack, action });
    const count = await remindPendingIsolationActions({ store, slack });
    assert.equal(count, 1);
    assert.deepEqual(notified, [action.id, action.id]);
    assert.equal(store.pendingIsolationActions().length, 1);
    assert.equal(store.pendingIsolationActions()[0]?.id, action.id);
  });

  it("does not request or remind a canary buy after one is executed (D60)", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const executed = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy canary fleet",
      proof: "Bought.",
      detail: { domains: ["getcrosslaunchco.info"] },
    });
    store.upsertIsolationAction({ ...executed, status: "executed" });
    const leftover = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy canary fleet",
      proof: "Again.",
      detail: {},
    });
    store.upsertIsolationAction(leftover);
    const second = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "buy_canary_fleet",
        title: "Buy canary fleet",
        proof: "Still.",
        detail: {},
      }),
    });
    assert.equal(second, null);
    const count = await remindPendingIsolationActions({ store, slack });
    assert.equal(count, 0);
    assert.deepEqual(notified, []);
  });

});

describe("D137 — one isolation-domain buy ask, ever", () => {
  it("an executed buy means the rig never asks again", async () => {
    const store = new StateStore(
      `/tmp/dw-iso-ask-${process.pid}-${Date.now()}.json`,
    );
    await store.load();
    const { slack, notified } = slackCapture();
    const ask = () =>
      buildIsolationAction({
        kind: "buy_isolation_domain",
        title: "Arm the word-hunt rig: buy its isolation domain",
        proof: "Still.",
        detail: { quantity: 1, isolationRig: true },
      });
    const first = await requestIsolationAction({ store, slack, action: ask() });
    assert.ok(first, "first ask posts");
    assert.equal(first?.allowed, "owner", "spend asks are owner-only");
    // pending → dedupe
    assert.equal(await requestIsolationAction({ store, slack, action: ask() }), null);
    // executed → still dedupe: the rig is armed for life
    store.upsertIsolationAction({
      ...first!,
      status: "executed",
      executedAt: new Date().toISOString(),
    });
    assert.equal(await requestIsolationAction({ store, slack, action: ask() }), null);
    assert.equal(notified.length, 1);
  });
});
