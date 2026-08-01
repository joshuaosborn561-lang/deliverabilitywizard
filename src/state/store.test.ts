import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "./store.js";

describe("spend approval state", () => {
  it("only decides pending approvals and consumes approved ones once", async () => {
    const state = new StateStore(
      `/tmp/dw-state-test-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertSpendApproval({
      id: "spend-1",
      requestKey: "spend-1",
      kind: "test",
      description: "test spend",
      detail: {},
      requestedAt: new Date().toISOString(),
      status: "pending",
    });

    assert.equal(
      state.decideSpendApproval("spend-1", "denied")?.status,
      "denied",
    );
    assert.equal(
      state.decideSpendApproval("spend-1", "approved"),
      undefined,
      "a denial must not be reversible",
    );

    state.upsertSpendApproval({
      id: "spend-2",
      requestKey: "spend-2",
      kind: "test",
      description: "test spend",
      detail: {},
      requestedAt: new Date().toISOString(),
      status: "pending",
    });
    state.decideSpendApproval("spend-2", "approved");
    assert.equal(
      state.consumeSpendApproval("spend-2")?.status,
      "consumed",
    );
    assert.equal(
      state.consumeSpendApproval("spend-2"),
      undefined,
      "a consumed approval must not be reusable",
    );
  });
});

describe("ops audit state", () => {
  it("keeps a bounded newest-first operations history", async () => {
    const state = new StateStore(
      `/tmp/dw-ops-audit-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    for (let index = 0; index < 505; index += 1) {
      state.appendOpsAudit({
        id: String(index),
        at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
        actor: "cayden",
        role: "operator",
        action: "status",
        outcome: "success",
      });
    }
    assert.equal(state.get().opsAudit.length, 500);
    assert.equal(state.listOpsAudit(1)[0]?.id, "504");
    assert.equal(state.get().opsAudit[0]?.id, "5");
  });
});
