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

describe("D176 attach blocklist", () => {
  it("persists a domain + account-id block across load", async () => {
    const filePath = `/tmp/dw-attach-block-${process.pid}-${Date.now()}.json`;
    const state = new StateStore(filePath);
    await state.load();
    state.upsertAttachBlock({
      domain: "cleartechco.com",
      emails: ["ada@cleartechco.com"],
      accountIds: [42004],
      reason: "sender_blocked",
      source: "campaign:3851730",
    });
    await state.save();

    const reloaded = new StateStore(filePath);
    await reloaded.load();
    const block = reloaded.getAttachBlock("cleartechco.com");
    assert.ok(block);
    assert.deepEqual(block.emails, ["ada@cleartechco.com"]);
    assert.deepEqual(block.accountIds, [42004]);
    assert.equal(
      reloaded.isSenderAttachBlocked({ email: "other@cleartechco.com" }),
      true,
    );
    assert.equal(
      reloaded.isSenderAttachBlocked({ email: "ok@goliath.com" }),
      false,
    );
  });
});

describe("D167 serialized save", () => {
  it("does not let an earlier snapshot clobber a later stage lastOk", async () => {
    const filePath = `/tmp/dw-state-save-${process.pid}-${Date.now()}.json`;
    const state = new StateStore(filePath);
    await state.load();
    state.recordStageOk("campaign-audit", 1000);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredHold = new Promise<void>((resolve) => {
      entered = resolve;
    });
    state.onSaveSnapshot = async () => {
      entered();
      await held;
    };

    const first = state.save();
    await enteredHold;
    state.recordStageOk("sending-infra", 200);
    const second = state.save();
    release();
    await Promise.all([first, second]);

    const reloaded = new StateStore(filePath);
    await reloaded.load();
    const health = reloaded.listStageHealth();
    assert.ok(
      health["campaign-audit"]?.lastOkAt,
      "first checkpoint must survive",
    );
    assert.ok(
      health["sending-infra"]?.lastOkAt,
      "a later recordStageOk must not be lost to an overlapping save rename",
    );
  });
});
