import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlackClient } from "../clients/slack.js";
import { StateStore } from "../state/store.js";
import {
  buildIsolationAction,
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
});
