import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";

async function seeded(records: number, perRecord: number): Promise<StateStore> {
  const state = new StateStore(`/tmp/canary-index-${process.pid}-${Date.now()}-${Math.random()}.json`);
  await state.load();
  for (let c = 1; c <= records; c++) {
    state.setCopyCanaries(
      c,
      Array.from({ length: perRecord }, (_, i) => `U${c}_${i}@Canary${c}.test`),
    );
  }
  return state;
}

describe("D302 canary lookup index", () => {
  it("matches canary emails case-insensitively and rejects others", async () => {
    const state = await seeded(3, 2);
    assert.equal(state.isCopyCanary("u2_1@canary2.test"), true);
    assert.equal(state.isCopyCanary("U2_1@CANARY2.TEST"), true);
    assert.equal(state.isCopyCanary("someone@else.test"), false);
    assert.equal(state.listCopyCanaryEmails().size, 6);
  });

  it("sees adds and removals without a stale cache", async () => {
    const state = await seeded(2, 1);
    assert.equal(state.isCopyCanary("new@fresh.test"), false);
    state.setCopyCanaries(99, ["new@fresh.test"]);
    assert.equal(state.isCopyCanary("new@fresh.test"), true);
    state.setCopyCanaries(99, []);
    assert.equal(state.isCopyCanary("new@fresh.test"), false);
  });

  it("released canaries are never canaries", async () => {
    const state = await seeded(1, 1);
    state.setCopyCanaries(5, ["gone@released.test"]);
    assert.equal(state.isCopyCanary("gone@released.test"), true);
    state.mergeReleasedCanaryFleet({ emails: ["gone@released.test"] });
    assert.equal(state.isReleasedCanary("gone@released.test"), true);
    assert.equal(state.isCopyCanary("gone@released.test"), false);
  });

  it("stays fast on a large canary book (no per-call re-merge)", async () => {
    const state = await seeded(300, 20);
    const started = performance.now();
    for (let i = 0; i < 2_000; i++) state.isCopyCanary(`x${i}@book.test`);
    const ms = performance.now() - started;
    // Before D302 this was ~21ms per call (~40s for 2,000 mailboxes).
    assert.ok(ms < 500, `2,000 lookups took ${Math.round(ms)}ms`);
  });
});
