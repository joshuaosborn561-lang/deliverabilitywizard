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
