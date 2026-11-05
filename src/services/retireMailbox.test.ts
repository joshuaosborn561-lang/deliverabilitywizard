import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { IsolationExecuteService } from "./isolationExecute.js";

describe("D303 retire_mailbox approval executes mailbox-only", () => {
  it("detaches just that mailbox, marks it retired, never touches the domain", async () => {
    const state = new StateStore(`/tmp/d303-rm-${process.pid}-${Math.random()}.json`);
    await state.load();
    state.upsertMailboxRest({ email: "box@c.com", clientId: 5, pod: "A", status: "burned", restedAt: "2026-10-01T00:00:00Z", returnAt: "2026-10-15T00:00:00Z", removedFromCampaigns: [11, 12], coveringGeneric: null } as never);
    const calls: string[] = [];
    const smartlead = { removeEmailAccountsFromCampaign: async (c: number, ids: number[]) => { calls.push(`rm ${c} ${ids}`); return {}; } };
    const svc = new IsolationExecuteService({} as never, smartlead as never, {} as never, state, {} as never, {} as never);
    const msg = await (svc as unknown as { runApproved: (a: unknown, actor: string) => Promise<string> }).runApproved(
      { id: "x", kind: "retire_mailbox", title: "t", proof: "p", status: "approved", detail: { email: "box@c.com", accountId: 7, campaignIds: [11, 12], clientId: 5 } },
      "Josh",
    );
    assert.deepEqual(calls, ["rm 11 7", "rm 12 7"]);
    assert.match(msg, /retired box@c\.com only/);
    assert.ok(state.getMailboxRest("box@c.com")!.retiredAt);
  });
});
