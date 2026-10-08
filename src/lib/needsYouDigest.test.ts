import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { buildIsolationAction } from "./isolationActions.js";
import {
  buildNeedsYouDigest,
  isolationIdsForClient,
} from "./needsYouDigest.js";
import { isolationBlockActionShouldDecide } from "./slackConfirmButtons.js";

function tempStore(): StateStore {
  return new StateStore(
    `/tmp/dw-needs-you-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("D248 — Needs you digest lumps Cayden spend per client", () => {
  it("one Approve button per client with Slack confirm; Josh-only listed separately", () => {
    const store = tempStore();
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "retire_domain",
        title: "Retire techevolutionusa.info",
        proof: "AS(42004)",
        detail: {
          domain: "techevolutionusa.info",
          ownerClientId: 521881,
          ownerClientName: "TechEvo",
        },
      }),
    );
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "buy_domains",
        title: "Buy cover for boxmeetconnect.com",
        proof: "cover",
        detail: {
          domain: "boxmeetconnect.com",
          ownerClientId: 521881,
          ownerClientName: "TechEvo",
        },
      }),
    );
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "generic_backfill",
        title: "Allow generics on 2 campaigns",
        proof: "floor",
        detail: { campaignIds: [1, 2] },
      }),
    );

    const digest = buildNeedsYouDigest(store);
    assert.ok(digest.text);
    assert.match(digest.text!, /Needs you/);
    assert.match(digest.text!, /TechEvo/);
    assert.match(digest.text!, /Josh only/);
    assert.match(digest.text!, /Allow generics/);
    assert.equal(digest.cayden.length, 1);
    assert.equal(digest.cayden[0]?.items.length, 2);

    const actions = (digest.blocks ?? []).find(
      (b) => (b as { type?: string }).type === "actions",
    ) as { elements?: Array<Record<string, unknown>> } | undefined;
    const approve = actions?.elements?.[0];
    assert.ok(approve);
    assert.equal("url" in approve, false);
    assert.ok(approve.confirm, "lumped Approve must confirm before spend");
    assert.match(String(approve.action_id), /needs_you_approve_client/);
    assert.equal(
      isolationBlockActionShouldDecide({
        action_id: String(approve.action_id),
        value: String(approve.value),
        url: "https://example.test/slack/action",
      }).decide,
      false,
      "a url leftover on the lump button must not spend",
    );
    assert.deepEqual(
      isolationIdsForClient(digest.items, digest.cayden[0]!.clientKey).length,
      2,
    );
  });
});
