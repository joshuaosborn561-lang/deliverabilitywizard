import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { buildIsolationAction } from "./isolationActions.js";
import {
  buildCaydenSpendDigest,
  collectPendingSpendItems,
  groupSpendItemsByClient,
  spendDigestText,
} from "./spendDigest.js";

function tempStore(): StateStore {
  return new StateStore(
    `/tmp/dw-spend-digest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("Cayden per-client spend digest (D220)", () => {
  it("groups pending Retire covers and inbox buys per client into one approval", () => {
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
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "buy_domains",
        title: "Buy a replacement for getboldercyperpartner.info",
        proof: "cover",
        detail: {
          domain: "getboldercyperpartner.info",
          ownerKind: "client",
          ownerClientId: 542838,
          ownerClientName: "BCP",
        },
      }),
    );
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "retire_domain",
        title: "Retire techevolutionusa.info",
        proof: "AS(42004)",
        detail: {
          domain: "techevolutionusa.info",
          ownerKind: "client",
          ownerClientId: 521881,
          ownerClientName: "TechEvo",
        },
      }),
    );
    store.upsertSpendApproval({
      id: "inboxkit:bcp:new.info",
      kind: "inboxkit_mailbox_purchase",
      description: "Buy 3 inboxes on getboldercyperpartnernew.info",
      detail: {
        domain: "getboldercyperpartnernew.info",
        clientId: 542838,
        clientName: "BCP",
      },
      requestedAt: new Date().toISOString(),
      status: "pending",
    });

    const digest = buildCaydenSpendDigest(store);
    assert.equal(digest.groups.length, 2);
    assert.equal(digest.groups[0]?.clientName, "BCP");
    assert.equal(digest.groups[0]?.items.length, 3);
    assert.equal(digest.groups[1]?.clientName, "TechEvo");
    assert.equal(digest.groups[1]?.items.length, 1);
    assert.ok(digest.text);
    assert.match(digest.text, /\*BCP\*/);
    assert.match(digest.text, /Retire boldercyperpartnerhub\.info/);
    assert.match(digest.text, /Buy cover for getboldercyperpartner\.info/);
    assert.match(digest.text, /Buy 3 inboxes on getboldercyperpartnernew\.info/);
    assert.match(digest.text, /\*TechEvo\*/);
    assert.match(digest.text, /one approval per client/);
    assert.doesNotMatch(digest.text, /—/);
  });

  it("drops resolved, retired, and already-spent cover rows", () => {
    const store = tempStore();
    const retired = buildIsolationAction({
      kind: "retire_domain",
      title: "Retire oldburned.info",
      proof: "done",
      detail: { domain: "oldburned.info" },
    });
    store.upsertIsolationAction({ ...retired, status: "executed" });
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "retire_domain",
        title: "Retire oldburned.info again",
        proof: "stale",
        detail: { domain: "oldburned.info" },
      }),
    );
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "buy_domains",
        title: "Buy cover for alreadybought.info",
        proof: "pending leftover",
        detail: { domain: "alreadybought.info", retiredDomain: "alreadybought.info" },
      }),
    );
    store.upsertIsolationAction({
      ...buildIsolationAction({
        kind: "buy_domains",
        title: "Buy cover for alreadybought.info (spent)",
        proof: "bought",
        detail: { domain: "alreadybought.info", retiredDomain: "alreadybought.info" },
      }),
      status: "executed",
    });
    store.upsertSpendApproval({
      id: "porkbun:used",
      kind: "porkbun_domain",
      description: "Buy used.info",
      detail: { domain: "used.info" },
      requestedAt: new Date().toISOString(),
      status: "consumed",
    });
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "swap_copy",
        title: "Swap a word",
        proof: "not spend",
        detail: { element: "free" },
      }),
    );

    const items = collectPendingSpendItems(store);
    assert.equal(items.length, 0);
    assert.equal(spendDigestText(groupSpendItemsByClient(items)), null);
  });
});
