import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyGenericSeat } from "./genericPool.js";
import {
  mayStripPodTagOnGenericReturn,
  returnGenericToUntaggedPool,
} from "./genericReturn.js";
import { stampMailboxPodTag } from "./genericAssign.js";
import { mayWritePodTag } from "./podTagLock.js";
import { StateStore } from "../state/store.js";

function stateFile(): string {
  return `/tmp/genreturn-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe("D235 generic return to the untagged pool", () => {
  it("allows strip-on-return for a generic and refuses a named seat", () => {
    assert.equal(
      mayStripPodTagOnGenericReturn({ tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }] }),
      true,
    );
    assert.equal(
      mayStripPodTagOnGenericReturn({ tags: [{ tag_name: "POD-A" }] }),
      false,
    );
  });

  it("clears client_id, signature, POD tag, and records released_at", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    state.upsertGenericSeat(
      emptyGenericSeat("ada@getintroduced.info", {
        slAccountId: 9,
        assignedClientId: 77,
        assignedPod: "A",
        assignedAt: "2026-10-01T00:00:00.000Z",
        reason: "pod_top_up",
      }),
    );
    const removed: Array<[number[], number[]]> = [];
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const account = {
      id: 9,
      from_email: "ada@getintroduced.info",
      client_id: 77,
      signature: "Ada Pool\nTechEvo",
      tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
    };
    const now = new Date("2026-10-04T12:00:00.000Z");
    const result = await returnGenericToUntaggedPool({
      smartlead: {
        updateEmailAccount: async (id, fields) => {
          writes.push({ id, fields });
        },
        ensureTag: async (name) => ({
          id: name === "POD-A" ? 1 : name === "POD-B" ? 2 : 3,
          name,
        }),
        removeTags: async (ids, tagIds) => {
          removed.push([ids, tagIds]);
        },
      },
      state,
      account,
      email: "ada@getintroduced.info",
      reason: "surplus_return",
      now,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(writes, [{ id: 9, fields: { client_id: null, signature: "" } }]);
    assert.deepEqual(removed, [[[9], [1, 2, 3]]]);
    assert.deepEqual(account.tags, [{ tag_name: "GENERIC" }]);
    assert.equal(account.client_id, null);
    assert.equal(account.signature, "");
    const seat = state.getGenericSeat("ada@getintroduced.info");
    assert.equal(seat?.assignedClientId, null);
    assert.equal(seat?.assignedPod, null);
    assert.equal(seat?.releasedAt, "2026-10-04T12:00:00.000Z");
    assert.equal(seat?.releaseHistory[0]?.clientId, 77);
    assert.equal(seat?.releaseHistory[0]?.pod, "A");
  });

  it("D234: still first-tags an untagged generic and never flips a named seat", () => {
    assert.equal(mayWritePodTag([{ tag_name: "GENERIC" }], "B"), true);
    const stamped = stampMailboxPodTag([{ tag_name: "GENERIC" }], "B");
    assert.deepEqual(stamped, [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }]);
    assert.equal(mayWritePodTag([{ tag_name: "POD-A" }], "B"), false);
    assert.deepEqual(stampMailboxPodTag([{ tag_name: "POD-A" }], "B"), [
      { tag_name: "POD-A" },
    ]);
  });

  it("refuses to strip a named seat", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const result = await returnGenericToUntaggedPool({
      smartlead: {
        updateEmailAccount: async () => {
          throw new Error("must not write a named seat");
        },
      },
      state,
      account: {
        id: 1,
        from_email: "josh@joshuaosbornco.info",
        client_id: 582890,
        tags: [{ tag_name: "POD-A" }],
      },
      email: "josh@joshuaosbornco.info",
      reason: "surplus_return",
    });
    assert.deepEqual(result, { ok: false, reason: "named" });
  });
});
