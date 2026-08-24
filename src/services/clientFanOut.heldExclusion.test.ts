import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { HeldInboxRecord, StateStore } from "../state/store.js";
import { ClientFanOutService } from "./clientFanOut.js";

/**
 * Remediation benches a sender for bad placement (D5) or bounce (D6) and tags
 * it HOLD-UNTIL. Fan-out (D26) is additive across a client's ACTIVE campaigns
 * and runs every 15 minutes, so without a held check it re-attaches benched
 * senders to every campaign for that client — which is how held mailboxes kept
 * reappearing on live BCP campaigns.
 */

function heldRecord(email: string): HeldInboxRecord {
  return {
    accountId: 100,
    email,
    heldAt: "2026-08-11T00:00:00.000Z",
    holdUntil: "2026-08-25",
    tagName: "HOLD-UNTIL-2026-08-25",
  };
}

function fixture(opts: {
  heldEmails?: string[];
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
        from_email: "held@boldercyperpartnerbiz.info",
        campaign_ids: [1],
        client_id: 9,
        tags: opts.tags ?? [],
      },
      {
        id: 101,
        from_email: "healthy@boldercyperpartnerbiz.info",
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

  const heldSet = new Set((opts.heldEmails ?? []).map((e) => e.toLowerCase()));
  const state = {
    getPoolMailbox: () => undefined,
    getHeldInbox: (email: string) =>
      heldSet.has(email.toLowerCase()) ? heldRecord(email) : undefined,
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
  it("never fans out a mailbox held in state", async () => {
    const { service, adds } = fixture({
      heldEmails: ["held@boldercyperpartnerbiz.info"],
    });

    const result = await service.run({ dryRun: false });

    const addedIds = adds.flatMap(([, ids]) => ids);
    assert.ok(
      !addedIds.includes(100),
      "held mailbox must not be re-attached to a campaign",
    );
    assert.ok(addedIds.includes(101), "healthy mailbox should still fan out");
    assert.ok(
      result.skipped.some((s) => s.includes("held@boldercyperpartnerbiz.info")),
      "the skip should be reported, not silent",
    );
  });

  it("never fans out a mailbox carrying an unexpired HOLD-UNTIL tag", async () => {
    // Held in Smartlead but missing from state — e.g. tagged by the backfill.
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
          from_email: "gone@retired.info",
          campaign_ids: [1],
          client_id: 9,
          tags: [],
        },
        {
          id: 201,
          from_email: "healthy@boldercyperpartnerbiz.info",
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
        getHeldInbox: () => undefined,
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
