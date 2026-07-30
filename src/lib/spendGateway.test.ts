import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpendGateway } from "./spendGateway.js";
import type { SlackClient } from "../clients/slack.js";
import type { SpendApprovalRecord, StateStore } from "../state/store.js";

function fakeState(): StateStore {
  const records = new Map<string, SpendApprovalRecord>();
  return {
    getSpendApproval: (id: string) => records.get(id),
    upsertSpendApproval: (record: SpendApprovalRecord) => {
      records.set(record.id, record);
    },
    listSpendApprovals: () => [...records.values()],
    decideSpendApproval: (
      id: string,
      status: "approved" | "denied",
      decidedBy?: string,
    ) => {
      const record = records.get(id);
      if (!record) return undefined;
      record.status = status;
      record.decidedAt = new Date().toISOString();
      if (decidedBy) record.decidedBy = decidedBy;
      return record;
    },
  } as unknown as StateStore;
}

function fakeSlack(): { sent: string[]; client: SlackClient } {
  const sent: string[] = [];
  const client = {
    send: async (text: string) => {
      sent.push(text);
    },
  } as unknown as SlackClient;
  return { sent, client };
}

describe("SpendGateway", () => {
  it("blocks a first-seen spend and creates a pending record", async () => {
    const state = fakeState();
    const { sent, client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);

    const decision = await gateway.authorize({
      key: "buy-1",
      kind: "test",
      description: "Buy 3 mailboxes",
    });

    assert.equal(decision.approved, false);
    assert.equal(decision.record.status, "pending");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /Spend approval needed/);
  });

  it("does not re-notify once a decision exists, and reflects it", async () => {
    const state = fakeState();
    const { sent, client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);

    await gateway.authorize({ key: "buy-2", kind: "test", description: "x" });
    state.decideSpendApproval("buy-2", "approved", "ops@example.com");

    const decision = await gateway.authorize({
      key: "buy-2",
      kind: "test",
      description: "x",
    });

    assert.equal(decision.approved, true);
    assert.equal(decision.record.decidedBy, "ops@example.com");
    assert.equal(sent.length, 1); // only the original pending notification
  });

  it("keeps a denied spend blocked", async () => {
    const state = fakeState();
    const { client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);

    await gateway.authorize({ key: "buy-3", kind: "test", description: "x" });
    state.decideSpendApproval("buy-3", "denied");

    const decision = await gateway.authorize({
      key: "buy-3",
      kind: "test",
      description: "x",
    });
    assert.equal(decision.approved, false);
    assert.equal(decision.record.status, "denied");
  });

  it("auto-approves everything when the gateway is disabled", async () => {
    const state = fakeState();
    const { sent, client } = fakeSlack();
    const gateway = new SpendGateway(state, client, false);

    const decision = await gateway.authorize({
      key: "buy-4",
      kind: "test",
      description: "x",
    });

    assert.equal(decision.approved, true);
    assert.equal(sent.length, 0);
    assert.equal(state.getSpendApproval("buy-4"), undefined);
  });
});
