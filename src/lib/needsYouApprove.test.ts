import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { buildIsolationAction } from "./isolationActions.js";
import {
  clientKeyFromNeedsYouActionId,
  encodeNeedsYouButtonValue,
  parseNeedsYouButtonValue,
  resolveNeedsYouIsolationIds,
} from "./needsYouDigest.js";
import {
  handleNeedsYouApproveClient,
  needsYouApproveLogLine,
  needsYouEmptyTapResult,
} from "./needsYouApprove.js";
import type { IsolationActionRecord } from "../state/isolationState.js";

function tempStore(): StateStore {
  return new StateStore(
    `/tmp/dw-needs-you-approve-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

function withId(
  row: IsolationActionRecord,
  id: string,
): IsolationActionRecord {
  return { ...row, id };
}

describe("D294 Needs-you Approve tap", () => {
  it("stamps isolation ids on the button so a regroup cannot empty the tap", () => {
    const encoded = encodeNeedsYouButtonValue("id:521881", [
      "retire_domain-1",
      "buy_domains-2",
    ]);
    assert.match(encoded, /^v1\|/);
    assert.doesNotMatch(encoded, /\s/);
    const parsed = parseNeedsYouButtonValue(encoded);
    assert.equal(parsed.clientKey, "id:521881");
    assert.deepEqual(parsed.ids, ["retire_domain-1", "buy_domains-2"]);
    assert.deepEqual(parseNeedsYouButtonValue("unassigned").ids, []);
    assert.deepEqual(
      parseNeedsYouButtonValue("unassigned\tretire_domain-1,buy_domains-2"),
      { clientKey: "unassigned", ids: ["retire_domain-1", "buy_domains-2"] },
    );
    const named = encodeNeedsYouButtonValue("name:acme corp", [
      "retire_domain-1790770900859-prbhu4",
    ]);
    assert.doesNotMatch(named, /\s/);
    assert.deepEqual(parseNeedsYouButtonValue(named), {
      clientKey: "name:acme corp",
      ids: ["retire_domain-1790770900859-prbhu4"],
    });
  });

  it("parses the Slack round-trip that folded the tab into a space", () => {
    const samples = [
      {
        value:
          "generic-pool retire_domain-1790770900859-prbhu4,buy_domains-1792926388368-n53tmm,buy_domains-1792926388436-y5lkrf,buy_domains-1793000092045-ztqpys,buy_domains-1793189015594-xl0ru5",
        clientKey: "generic-pool",
        ids: [
          "retire_domain-1790770900859-prbhu4",
          "buy_domains-1792926388368-n53tmm",
          "buy_domains-1792926388436-y5lkrf",
          "buy_domains-1793000092045-ztqpys",
          "buy_domains-1793189015594-xl0ru5",
        ],
      },
      {
        value: "id:582890 buy_domains-1793000092092-fzh7dt",
        clientKey: "id:582890",
        ids: ["buy_domains-1793000092092-fzh7dt"],
      },
      {
        value: "id:548611 buy_domains-1788891845621-igg0cq",
        clientKey: "id:548611",
        ids: ["buy_domains-1788891845621-igg0cq"],
      },
    ];
    for (const sample of samples) {
      assert.equal(sample.value.includes("\t"), false);
      const parsed = parseNeedsYouButtonValue(sample.value);
      assert.equal(parsed.clientKey, sample.clientKey);
      assert.deepEqual(parsed.ids, sample.ids);
      const legacy = `${sample.clientKey}\t${sample.ids.join(",")}`;
      assert.deepEqual(parseNeedsYouButtonValue(legacy), {
        clientKey: sample.clientKey,
        ids: sample.ids,
      });
      assert.deepEqual(parseNeedsYouButtonValue(legacy.replace(/\t/g, " ")), {
        clientKey: sample.clientKey,
        ids: sample.ids,
      });
    }
    const named = parseNeedsYouButtonValue(
      "name:acme corp retire_domain-1790770900859-prbhu4",
    );
    assert.equal(named.clientKey, "name:acme corp");
    assert.deepEqual(named.ids, ["retire_domain-1790770900859-prbhu4"]);
    assert.equal(
      clientKeyFromNeedsYouActionId("needs_you_approve_client:id:582890"),
      "id:582890",
    );
    assert.equal(
      clientKeyFromNeedsYouActionId("needs_you_approve_client:generic-pool"),
      "generic-pool",
    );
  });

  it("does not rewrite the card to nothing pending while that client still has rows", () => {
    const blocked = needsYouEmptyTapResult({
      actorName: "Cayden",
      clientKey: "generic-pool",
      pending: 2,
    });
    assert.equal(blocked.updateCard, false);
    assert.equal(blocked.failed, true);
    assert.doesNotMatch(blocked.text, /nothing pending/);
    assert.match(blocked.log, /applied nothing/);
    assert.match(blocked.log, /client=generic-pool/);
    assert.match(blocked.log, /pending=2/);
    assert.match(blocked.log, /reason=unresolved/);

    const clear = needsYouEmptyTapResult({
      actorName: "Cayden",
      clientKey: "generic-pool",
      pending: 0,
    });
    assert.equal(clear.updateCard, true);
    assert.equal(clear.failed, false);
    assert.match(clear.text, /Done by Cayden: nothing pending for that client/);
    assert.match(clear.log, /reason=none-pending/);
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

  it("approves a value Slack delivered with the tab turned into a space", async () => {
    const store = tempStore();
    await store.load();
    const retireId = "retire_domain-1790770900859-prbhu4";
    const buyId = "buy_domains-1792926388368-n53tmm";
    store.upsertIsolationAction(
      withId(
        buildIsolationAction({
          kind: "retire_domain",
          title: "Retire pool.info",
          proof: "AS(42004)",
          detail: { domain: "pool.info", ownerKind: "generic" },
        }),
        retireId,
      ),
    );
    store.upsertIsolationAction(
      withId(
        buildIsolationAction({
          kind: "buy_domains",
          title: "Buy cover for poolcover.info",
          proof: "cover",
          detail: { domain: "poolcover.info", ownerKind: "generic" },
        }),
        buyId,
      ),
    );
    const slackValue = `generic-pool\t${retireId},${buyId}`.replace(/\t/g, " ");
    assert.equal(slackValue.includes("\t"), false);
    const cards: string[] = [];
    const decided: string[] = [];
    const result = await handleNeedsYouApproveClient({
      actor: { name: "Cayden", role: "operator" },
      buttonValue: slackValue,
      state: store,
      isolationExecute: {
        stampApprovals: async (ids) => {
          for (const id of ids) {
            const row = store.getIsolationAction(id);
            if (!row || row.status !== "pending") continue;
            store.upsertIsolationAction({
              ...row,
              status: "approved",
              decidedAt: "2026-11-05T13:44:07.000Z",
              decidedBy: "Cayden",
            });
          }
          return ids;
        },
        decide: async (id) => {
          decided.push(id);
          return { ok: true, message: `Done by Cayden: ${id}` };
        },
      },
      updateCard: async (text) => {
        cards.push(text);
      },
    });
    assert.deepEqual(decided, [retireId, buyId]);
    assert.deepEqual(result.ids, [retireId, buyId]);
    assert.equal(result.failed, false);
    assert.match(cards.join("\n"), /working 2 item/);
    assert.doesNotMatch(cards.join("\n"), /nothing pending/);
  });

  it("falls back to the action_id client when the value has no ids", async () => {
    const store = tempStore();
    await store.load();
    const pool = buildIsolationAction({
      kind: "buy_domains",
      title: "Buy cover for joshuaosbornsalestry.info",
      proof: "cover",
      detail: { domain: "joshuaosbornsalestry.info", ownerKind: "generic" },
    });
    const other = buildIsolationAction({
      kind: "retire_domain",
      title: "Retire nobody.info",
      proof: "AS(42004)",
      detail: { domain: "nobody.info" },
    });
    const joshOnly = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy canary fleet",
      proof: "fleet",
      detail: {},
    });
    store.upsertIsolationAction(pool);
    store.upsertIsolationAction(other);
    store.upsertIsolationAction(joshOnly);
    const cards: string[] = [];
    const decided: string[] = [];
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const result = await handleNeedsYouApproveClient({
        actor: { name: "Cayden", role: "operator" },
        buttonValue: "unassigned",
        actionId: "needs_you_approve_client:generic-pool",
        state: store,
        isolationExecute: {
          stampApprovals: async (ids) => ids,
          decide: async (id) => {
            decided.push(id);
            return { ok: true, message: `Done by Cayden: ${id}` };
          },
        },
        updateCard: async (text) => {
          cards.push(text);
        },
      });
      assert.deepEqual(result.ids, [pool.id]);
      assert.deepEqual(decided, [pool.id]);
      assert.equal(decided.includes(other.id), false);
      assert.equal(decided.includes(joshOnly.id), false);
      assert.match(cards.join("\n"), /approved generic-pool/);
      assert.doesNotMatch(cards.join("\n"), /nothing pending/);
      assert.match(logs.join("\n"), /via=action_id applying=1/);
    } finally {
      console.log = originalLog;
    }
  });

  it("logs and still says nothing pending only when that client has no rows", async () => {
    const store = tempStore();
    await store.load();
    const cards: string[] = [];
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const result = await handleNeedsYouApproveClient({
        actor: { name: "Cayden", role: "operator" },
        buttonValue: "generic-pool",
        actionId: "needs_you_approve_client:generic-pool",
        state: store,
        isolationExecute: {
          stampApprovals: async () => {
            throw new Error("stampApprovals should not run");
          },
          decide: async () => {
            throw new Error("decide should not run");
          },
        },
        updateCard: async (text) => {
          cards.push(text);
        },
      });
      assert.deepEqual(result.ids, []);
      assert.equal(result.failed, false);
      assert.match(result.text, /nothing pending for that client/);
      assert.deepEqual(cards, [result.text]);
      assert.match(logs.join("\n"), /applied nothing/);
      assert.match(logs.join("\n"), /client=generic-pool/);
      assert.match(logs.join("\n"), /pending=0/);
      assert.match(logs.join("\n"), /reason=none-pending/);
    } finally {
      console.log = originalLog;
    }
  });
});
