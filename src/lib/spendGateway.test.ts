import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpendGateway } from "./spendGateway.js";
import type { SlackClient } from "../clients/slack.js";
import type { SpendApprovalRecord, StateStore } from "../state/store.js";
import { emptyMonthlyUsage } from "./monthlyCaps.js";

function fakeState(): StateStore {
  const records = new Map<string, SpendApprovalRecord>();
  const usage = emptyMonthlyUsage();
  return {
    getSpendApproval: (id: string) => records.get(id),
    getLatestSpendApprovalForRequest: (requestKey: string) =>
      [...records.values()]
        .filter((record) => (record.requestKey ?? record.id) === requestKey)
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0],
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
      if (!record || record.status !== "pending") return undefined;
      record.status = status;
      record.decidedAt = new Date().toISOString();
      if (decidedBy) record.decidedBy = decidedBy;
      return record;
    },
    consumeSpendApproval: (id: string) => {
      const record = records.get(id);
      if (!record || record.status !== "approved") return undefined;
      record.status = "consumed";
      return record;
    },
    getClientMonthlyUsage: () => usage,
    recordDomainSpend: (
      _clientId: number | null,
      _clientName: string,
      usd: number,
    ) => {
      usage.domainSpendUsd += usd;
      return usage;
    },
    recordMailboxCreates: (
      _clientId: number | null,
      _clientName: string,
      count: number,
    ) => {
      usage.mailboxesCreated += count;
      return usage;
    },
    save: async () => undefined,
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
      scope: "generic_pool",
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

    await gateway.authorize({
      key: "buy-2",
      scope: "generic_pool",
      kind: "test",
      description: "x",
    });
    state.decideSpendApproval("buy-2", "approved", "ops@example.com");

    const decision = await gateway.authorize({
      key: "buy-2",
      scope: "generic_pool",
      kind: "test",
      description: "x",
    });

    assert.equal(decision.approved, true);
    assert.equal(decision.record.decidedBy, "ops@example.com");
    assert.equal(sent.length, 1); // only the original pending notification
  });

  it("consumes an approval after successful spend and requires a new cycle", async () => {
    const state = fakeState();
    const { sent, client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);
    const request = {
      key: "buy-once",
      scope: "generic_pool" as const,
      kind: "test",
      description: "x",
    };

    const pending = await gateway.authorize(request);
    state.decideSpendApproval(pending.record.id, "approved", "owner");
    const approved = await gateway.authorize(request);
    assert.equal(approved.approved, true);
    await gateway.consume(approved, request);
    assert.equal(state.getSpendApproval(approved.record.id)?.status, "consumed");

    const next = await gateway.authorize(request);
    assert.equal(next.approved, false);
    assert.equal(next.record.status, "pending");
    assert.notEqual(next.record.id, approved.record.id);
    assert.equal(sent.length, 2);
  });

  it("hard-blocks client spend above monthly caps", async () => {
    const state = fakeState();
    state.recordMailboxCreates(null, "Client A", 24);
    const { sent, client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);

    const decision = await gateway.authorize({
      key: "client-buy",
      scope: "client",
      kind: "client_mailboxes",
      description: "Buy two client mailboxes",
      clientSpend: {
        clientId: null,
        clientName: "Client A",
        mailboxesCreated: 2,
        domainCapUsd: 25,
        mailboxCap: 25,
      },
    });

    assert.equal(decision.approved, false);
    assert.equal(decision.record.status, "denied");
    assert.equal(decision.record.decidedBy, "monthly-cap");
    assert.match(sent[0]!, /blocked by monthly cap/i);
    const repeated = await gateway.authorize({
      key: "client-buy",
      scope: "client",
      kind: "client_mailboxes",
      description: "Buy two client mailboxes",
      clientSpend: {
        clientId: null,
        clientName: "Client A",
        mailboxesCreated: 2,
        domainCapUsd: 25,
        mailboxCap: 25,
      },
    });
    assert.equal(repeated.record.id, decision.record.id);
    assert.equal(sent.length, 1, "an unchanged cap block must not spam Slack");

    // A monthly-cap denial is not permanent across a new usage window.
    state.getClientMonthlyUsage(null, "Client A").mailboxesCreated = 0;
    const afterReset = await gateway.authorize({
      key: "client-buy",
      scope: "client",
      kind: "client_mailboxes",
      description: "Buy two client mailboxes",
      clientSpend: {
        clientId: null,
        clientName: "Client A",
        mailboxesCreated: 2,
        domainCapUsd: 25,
        mailboxCap: 25,
      },
    });
    assert.equal(afterReset.record.status, "pending");
    assert.notEqual(afterReset.record.id, decision.record.id);
  });

  it("refuses client spend without mandatory cap metadata", async () => {
    const state = fakeState();
    const { client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);
    const decision = await gateway.authorize({
      key: "uncapped-client-buy",
      scope: "client",
      kind: "client_mailboxes",
      description: "Unsafe client spend",
    });
    assert.equal(decision.approved, false);
    assert.equal(decision.record.decidedBy, "monthly-cap");
    assert.match(decision.record.description, /missing mandatory/i);
  });

  it("records client usage when an approved spend is consumed", async () => {
    const state = fakeState();
    const { client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);
    const request = {
      key: "client-domain",
      scope: "client" as const,
      kind: "client_domain",
      description: "Buy client domain",
      clientSpend: {
        clientId: 1,
        clientName: "Client A",
        domainSpendUsd: 3.6,
        mailboxesCreated: 5,
        domainCapUsd: 25,
        mailboxCap: 25,
      },
    };

    const pending = await gateway.authorize(request);
    state.decideSpendApproval(pending.record.id, "approved");
    const approved = await gateway.authorize(request);
    await gateway.consume(approved, request);

    const usage = state.getClientMonthlyUsage(1, "Client A");
    assert.equal(usage.domainSpendUsd, 3.6);
    assert.equal(usage.mailboxesCreated, 5);
  });

  it("rechecks caps atomically when consuming an approved spend", async () => {
    const state = fakeState();
    const { client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);
    const request = {
      key: "client-race",
      scope: "client" as const,
      kind: "client_mailboxes",
      description: "Buy client mailboxes",
      clientSpend: {
        clientId: 1,
        clientName: "Client A",
        mailboxesCreated: 2,
        domainCapUsd: 25,
        mailboxCap: 25,
      },
    };
    const pending = await gateway.authorize(request);
    state.decideSpendApproval(pending.record.id, "approved");
    const approved = await gateway.authorize(request);
    state.recordMailboxCreates(1, "Client A", 24);

    await assert.rejects(
      () => gateway.consume(approved, request),
      /blocked at execution time/i,
    );
    assert.equal(
      state.getSpendApproval(approved.record.id)?.status,
      "approved",
    );
  });

  it("keeps a denied spend blocked", async () => {
    const state = fakeState();
    const { client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);

    await gateway.authorize({
      key: "buy-3",
      scope: "generic_pool",
      kind: "test",
      description: "x",
    });
    state.decideSpendApproval("buy-3", "denied");

    const decision = await gateway.authorize({
      key: "buy-3",
      scope: "generic_pool",
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
      scope: "generic_pool",
      kind: "test",
      description: "x",
    });

    assert.equal(decision.approved, true);
    assert.equal(sent.length, 0);
    assert.equal(state.getSpendApproval("buy-4"), undefined);
  });

  it("Josh Slack tap writes an approved spend row without a second Slack ask", async () => {
    const state = fakeState();
    const { sent, client } = fakeSlack();
    const gateway = new SpendGateway(state, client, true);
    const request = {
      key: "porkbun:isolation:getcrosslaunchco.info",
      scope: "generic_pool" as const,
      kind: "porkbun_domain",
      description: "Replacement sending domain",
    };
    const decision = await gateway.recordOwnerApproved(request, "Josh");
    assert.equal(decision.approved, true);
    assert.equal(decision.record.status, "approved");
    assert.equal(decision.record.decidedBy, "Josh");
    assert.equal(sent.length, 0);
    await gateway.consume(decision, request);
    assert.equal(state.getSpendApproval(request.key)?.status, "consumed");
  });
});
