import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { buildIsolationAction } from "./isolationActions.js";
import { persistRetiredDomainHistory } from "./isolationActions.js";
import {
  markSpendDoneForAsk,
  pruneSatisfiedPendingSpend,
} from "./pendingSpendPrune.js";
import { collectPendingSpendItems } from "./spendDigest.js";

function tempStore(): StateStore {
  return new StateStore(
    `/tmp/dw-spend-prune-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("D266 — prune finished pendingSpend", () => {
  it("marks a leftover pending cover spend consumed when the cover is already bought", () => {
    const store = tempStore();
    const bought = buildIsolationAction({
      kind: "buy_domains",
      title: "Buy cover for alreadybought.info",
      proof: "bought",
      detail: {
        domain: "alreadybought.info",
        retiredDomain: "alreadybought.info",
        domains: ["cover.info"],
      },
    });
    store.upsertIsolationAction({
      ...bought,
      status: "executed",
      executedAt: "2026-10-13T12:00:00.000Z",
    });
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "buy_domains",
        title: "Buy cover leftover",
        proof: "stale",
        detail: { domain: "alreadybought.info" },
      }),
    );
    store.upsertSpendApproval({
      id: "inboxkit:alreadybought",
      kind: "inboxkit_mailbox_purchase",
      description: "Buy inboxes on alreadybought.info",
      detail: { domain: "alreadybought.info" },
      requestedAt: "2026-10-13T11:00:00.000Z",
      status: "pending",
    });
    const pruned = pruneSatisfiedPendingSpend(store);
    assert.ok(pruned.spend >= 1);
    assert.equal(store.getSpendApproval("inboxkit:alreadybought")?.status, "consumed");
    assert.equal(collectPendingSpendItems(store).length, 0);
  });

  it("drops a pending spend for a domain that is already retired", () => {
    const store = tempStore();
    persistRetiredDomainHistory(store, "oldburned.info");
    store.upsertSpendApproval({
      id: "porkbun:oldburned",
      kind: "porkbun_domain",
      description: "Buy replacement for oldburned.info",
      detail: { domain: "oldburned.info" },
      requestedAt: "2026-10-01T00:00:00.000Z",
      status: "pending",
    });
    pruneSatisfiedPendingSpend(store);
    assert.equal(store.getSpendApproval("porkbun:oldburned")?.status, "consumed");
    assert.equal(collectPendingSpendItems(store).length, 0);
  });

  it("D294: drops a leftover pending Retire when the domain is already burned on the attach-block", () => {
    const store = tempStore();
    store.upsertAttachBlock({
      domain: "boldercyperpartnerbiz.info",
      reason: "burned",
      source: "retire:boldercyperpartnerbiz.info",
    });
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "retire_domain",
        title: "Retire boldercyperpartnerbiz.info",
        proof: "Josh approved yesterday",
        detail: { domain: "boldercyperpartnerbiz.info" },
      }),
    );
    const pruned = pruneSatisfiedPendingSpend(store);
    assert.ok(pruned.isolation >= 1);
    assert.equal(collectPendingSpendItems(store).length, 0);
  });

  it("markSpendDoneForAsk consumes the tap's leftover pending rows", () => {
    const store = tempStore();
    store.upsertSpendApproval({
      id: "inboxkit:tap",
      kind: "inboxkit_mailbox_purchase",
      description: "Buy inboxes",
      detail: { domain: "fresh.info", actionId: "buy-1" },
      requestedAt: "2026-10-14T12:00:00.000Z",
      status: "pending",
    });
    const n = markSpendDoneForAsk(store, {
      actionId: "buy-1",
      domain: "fresh.info",
      decidedBy: "Cayden",
    });
    assert.equal(n, 1);
    assert.equal(store.getSpendApproval("inboxkit:tap")?.status, "consumed");
    assert.equal(store.getSpendApproval("inboxkit:tap")?.decidedBy, "Cayden");
  });
});
