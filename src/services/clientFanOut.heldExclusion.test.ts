import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { StateStore } from "../state/store.js";
import { ClientFanOutService } from "./clientFanOut.js";

/**
 * A leftover HOLD-UNTIL tag sits inert until it expires (D128). Fan-out (D26)
 * is additive across a client's ACTIVE campaigns and runs every 15 minutes,
 * so without the tag check it would re-attach benched senders to every
 * campaign for that client — which is how held mailboxes kept reappearing on
 * live BCP campaigns.
 */

function fixture(opts: {
  tags?: Array<{ tag_name: string }>;
}) {
  const adds: Array<[number, number[]]> = [];
  const smartlead = {
    listCampaigns: async () => [
      { id: 1, name: "BCP PE", status: "ACTIVE", client_id: 9 },
      { id: 2, name: "BCP Logistics", status: "ACTIVE", client_id: 9 },
    ],
    listAllEmailAccounts: async () => [
      {
        id: 100,
        from_email: "held@boldercyperpartnerbiz.info", created_at: "2026-06-01T00:00:00Z",
        campaign_ids: [1],
        client_id: 9,
        tags: opts.tags ?? [],
      },
      {
        id: 101,
        from_email: "healthy@boldercyperpartnerbiz.info", created_at: "2026-06-01T00:00:00Z",
        campaign_ids: [1],
        client_id: 9,
        tags: [],
      },
    ],
    listClients: async () => [{ id: 9, name: "BCP" }],
    addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
      adds.push([campaignId, [...ids]]);
    },
    updateEmailAccount: async () => undefined,
  } as unknown as SmartleadClient;

  const state = {
    getPoolMailbox: () => undefined,
    isCopyCanary: () => false,
    getRestingInbox: () => undefined,
    getDomainHistory: (domain?: string) =>
      domain === "retired.info" ? { status: "retired" } : undefined,
  } as unknown as StateStore;

  const service = new ClientFanOutService(
    loadConfig({}),
    smartlead,
    { send: async () => undefined } as unknown as SlackClient,
    state,
  );
  return { service, adds };
}

describe("ClientFanOutService held exclusion", () => {
  it("never fans out a mailbox carrying an unexpired HOLD-UNTIL tag", async () => {
    const { service, adds } = fixture({
      tags: [{ tag_name: "HOLD-UNTIL-2099-01-01" }],
    });

    const result = await service.run({ dryRun: false });

    const addedIds = adds.flatMap(([, ids]) => ids);
    assert.ok(!addedIds.includes(100), "tag-held mailbox must not fan out");
    assert.ok(addedIds.includes(101));
    assert.ok(result.skipped.some((s) => s.includes("HOLD-UNTIL")));
  });

  it("never fans out a mailbox on a retired domain", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "BCP PE", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "BCP Logistics", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 200,
          from_email: "gone@retired.info", created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [1],
          client_id: 9,
          tags: [],
        },
        {
          id: 201,
          from_email: "healthy@boldercyperpartnerbiz.info", created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [1],
          client_id: 9,
          tags: [],
        },
      ],
      listClients: async () => [{ id: 9, name: "BCP" }],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        adds.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;
    const service = new ClientFanOutService(
      loadConfig({}),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      {
        getPoolMailbox: () => undefined,
        isCopyCanary: () => false,
        getRestingInbox: () => undefined,
        getDomainHistory: (domain?: string) =>
          domain === "retired.info" ? { status: "retired" } : undefined,
      } as unknown as StateStore,
    );
    const result = await service.run({ dryRun: false });
    const addedIds = adds.flatMap(([, ids]) => ids);
    assert.ok(!addedIds.includes(200), "retired-domain mailbox must stay off");
    assert.ok(addedIds.includes(201));
    assert.ok(result.skipped.some((s) => s.includes("retired domain")));
  });

  it("D176: never fans out a sender on an attach-blocked domain", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 3851730, name: "Goliath MDR", status: "ACTIVE", client_id: 548611 },
        { id: 3851731, name: "Goliath MSP", status: "ACTIVE", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 42004,
          from_email: "ada@cleartechco.com",
          created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [3851730],
          client_id: 548611,
          tags: [],
        },
        {
          id: 42005,
          from_email: "ok@goliathcyber.com",
          created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [3851730],
          client_id: 548611,
          tags: [],
        },
      ],
      listClients: async () => [{ id: 548611, name: "Goliath Cybersecurity" }],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        adds.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;
    const service = new ClientFanOutService(
      loadConfig({}),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      {
        getPoolMailbox: () => undefined,
        isCopyCanary: () => false,
        getRestingInbox: () => undefined,
        getDomainHistory: () => undefined,
        listAttachBlocks: () => [
          {
            domain: "cleartechco.com",
            emails: ["ada@cleartechco.com"],
            accountIds: [42004],
            reason: "sender_blocked",
            blockedAt: "2026-09-03T20:23:00.000Z",
          },
        ],
        listIsolationActions: () => [],
      } as unknown as StateStore,
    );
    const result = await service.run({ dryRun: false });
    const addedIds = adds.flatMap(([, ids]) => ids);
    assert.ok(
      !addedIds.includes(42004),
      "AS(42004) cleartechco sender must stay off after unlink",
    );
    assert.ok(addedIds.includes(42005), "healthy sibling still fans out");
    assert.ok(result.skipped.some((s) => s.includes("attach blocked")));
  });

  it("still fans out when a HOLD-UNTIL tag has expired", async () => {
    const { service, adds } = fixture({
      tags: [{ tag_name: "HOLD-UNTIL-2020-01-01" }],
    });

    await service.run({ dryRun: false });

    const addedIds = adds.flatMap(([, ids]) => ids);
    assert.ok(
      addedIds.includes(100),
      "an expired hold must not bench a mailbox forever",
    );
  });
});
