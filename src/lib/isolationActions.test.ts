import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlackClient } from "../clients/slack.js";
import { StateStore } from "../state/store.js";
import {
  buildIsolationAction,
  coveredSignatureCampaigns,
  remindPendingIsolationActions,
  requestIsolationAction,
  supersedePendingSingleSignatureAsks,
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

  it("dedupes a pending signature ask per campaign, not across campaigns (D85)", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const ask = (campaignId: number) =>
      buildIsolationAction({
        kind: "add_signature_tag",
        title: `%signature% missing on #${campaignId}`,
        proof: "step 1 A is missing %signature%",
        detail: { campaignId },
      });
    const first = await requestIsolationAction({ store, slack, action: ask(1) });
    const repeat = await requestIsolationAction({ store, slack, action: ask(1) });
    const other = await requestIsolationAction({ store, slack, action: ask(2) });
    assert.ok(first);
    assert.equal(repeat, null);
    assert.ok(other);
    assert.equal(notified.length, 2);
  });

  it("does not re-ask for a signature fix right after execute or deny (D85)", async () => {
    const store = tempStore();
    const { slack } = slackCapture();
    const executed = buildIsolationAction({
      kind: "add_signature_tag",
      title: "done",
      proof: "done",
      detail: { campaignId: 5 },
    });
    store.upsertIsolationAction({
      ...executed,
      status: "executed",
      executedAt: new Date().toISOString(),
    });
    const afterExecute = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "add_signature_tag",
        title: "again",
        proof: "again",
        detail: { campaignId: 5 },
      }),
    });
    assert.equal(afterExecute, null);

    const denied = buildIsolationAction({
      kind: "add_signature_tag",
      title: "no",
      proof: "no",
      detail: { campaignId: 6 },
    });
    store.upsertIsolationAction({
      ...denied,
      status: "denied",
      decidedAt: new Date().toISOString(),
    });
    const afterDeny = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "add_signature_tag",
        title: "retry",
        proof: "retry",
        detail: { campaignId: 6 },
      }),
    });
    assert.equal(afterDeny, null);

    // An old executed record (new copy shipped later) allows a fresh ask.
    const stale = buildIsolationAction({
      kind: "add_signature_tag",
      title: "old",
      proof: "old",
      detail: { campaignId: 7 },
    });
    store.upsertIsolationAction({
      ...stale,
      status: "executed",
      executedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const fresh = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "add_signature_tag",
        title: "new copy",
        proof: "new copy",
        detail: { campaignId: 7 },
      }),
    });
    assert.ok(fresh);
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

  it("D89: pending singles collapse so a bulk ask can own those campaigns", async () => {
    const store = tempStore();
    const { slack } = slackCapture();
    const one = buildIsolationAction({
      kind: "add_signature_tag",
      title: "one",
      proof: "one",
      detail: { campaignId: 81 },
    });
    const two = buildIsolationAction({
      kind: "add_signature_tag",
      title: "two",
      proof: "two",
      detail: { campaignId: 82 },
    });
    await requestIsolationAction({ store, slack, action: one });
    await requestIsolationAction({ store, slack, action: two });

    assert.deepEqual(
      [...coveredSignatureCampaigns(store.listIsolationActions())].sort(),
      [81, 82],
    );

    const collapsed = supersedePendingSingleSignatureAsks(store, [81, 82, 83]);
    assert.equal(collapsed, 2);
    assert.deepEqual(
      [...coveredSignatureCampaigns(store.listIsolationActions())],
      [],
      "superseded singles must not keep owning those campaigns",
    );

    const bulk = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "add_signature_tag",
        title: "bulk",
        proof: "bulk",
        detail: { campaignIds: [81, 82, 83] },
      }),
    });
    assert.ok(bulk);
    assert.deepEqual(
      [...coveredSignatureCampaigns(store.listIsolationActions())].sort(),
      [81, 82, 83],
    );
  });
});
