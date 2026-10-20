import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { buildIsolationAction } from "./isolationActions.js";
import {
  encodeNeedsYouButtonValue,
  parseNeedsYouButtonValue,
  resolveNeedsYouIsolationIds,
} from "./needsYouDigest.js";
import {
  handleNeedsYouApproveClient,
  needsYouApproveLogLine,
} from "./needsYouApprove.js";

function tempStore(): StateStore {
  return new StateStore(
    `/tmp/dw-needs-you-approve-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("D294 Needs-you Approve tap", () => {
  it("stamps isolation ids on the button so a regroup cannot empty the tap", () => {
    const encoded = encodeNeedsYouButtonValue("id:521881", [
      "retire_domain-1",
      "buy_domains-2",
    ]);
    const parsed = parseNeedsYouButtonValue(encoded);
    assert.equal(parsed.clientKey, "id:521881");
    assert.deepEqual(parsed.ids, ["retire_domain-1", "buy_domains-2"]);
    assert.deepEqual(parseNeedsYouButtonValue("unassigned").ids, []);
  });

  it("keeps stamped ids when live grouping moved off Unassigned", () => {
    const store = tempStore();
    const retire = buildIsolationAction({
      kind: "retire_domain",
      title: "Retire leftover.info",
      proof: "AS(42004)",
      detail: { domain: "leftover.info", ownerClientId: 1, ownerClientName: "Acme" },
    });
    store.upsertIsolationAction(retire);
    const ids = resolveNeedsYouIsolationIds({
      items: [
        {
          source: "isolation",
          id: retire.id,
          kind: "retire_domain",
          label: "Retire leftover.info",
          clientKey: "id:1",
          clientName: "Acme",
          requestedAt: retire.requestedAt,
        },
      ],
      clientKey: "unassigned",
      stampedIds: [retire.id],
      getAction: (id) => store.getIsolationAction(id),
    });
    assert.deepEqual(ids, [retire.id]);
  });

  it("stamps approved before decide, then writes per-item card results including a buy failure", async () => {
    const store = tempStore();
    await store.load();
    const retire = buildIsolationAction({
      kind: "retire_domain",
      title: "Retire boldercyperpartnerbiz.info",
      proof: "AS(42004)",
      detail: { domain: "boldercyperpartnerbiz.info" },
    });
    store.upsertIsolationAction(retire);
    const cards: string[] = [];
    let stampedAtDecide = "";
    const isolationExecute = {
      stampApprovals: async (ids: string[]) => {
        for (const id of ids) {
          const row = store.getIsolationAction(id);
          if (!row || row.status !== "pending") continue;
          store.upsertIsolationAction({
            ...row,
            status: "approved",
            decidedAt: "2026-10-20T12:00:00.000Z",
            decidedBy: "Cayden",
          });
        }
        await store.persistIsolationDecisions();
        return ids;
      },
      decide: async (id: string) => {
        stampedAtDecide = store.getIsolationAction(id)?.status ?? "";
        return {
          ok: false,
          message:
            "Cayden — Replacement buy failed after the pull: Only found 0 available replacement domains. Client-named spins only.",
        };
      },
    };
    const result = await handleNeedsYouApproveClient({
      actor: { name: "Cayden", role: "operator" },
      buttonValue: encodeNeedsYouButtonValue("unassigned", [retire.id]),
      state: store,
      isolationExecute,
      updateCard: async (text) => {
        cards.push(text);
      },
    });
    assert.equal(stampedAtDecide, "approved");
    assert.equal(result.failed, true);
    assert.deepEqual(result.ids, [retire.id]);
    assert.match(result.text, /0 available replacement domains/);
    assert.ok(cards.some((row) => /working/.test(row)));
    assert.match(needsYouApproveLogLine({
      clientKey: "unassigned",
      actor: "Cayden",
      role: "operator",
      stamped: 1,
      ids: 1,
    }), /needs-you approve client=unassigned actor=Cayden/);
  });
});
