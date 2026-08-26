import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { RestingInboxRecord, StateStore } from "../state/store.js";
import { ClientFanOutService } from "./clientFanOut.js";

function restRecord(email: string): RestingInboxRecord {
  return {
    accountId: 100,
    email,
    clientId: "id:9",
    cohort: "B",
    restingSince: "2026-08-01T00:00:00.000Z",
    removedFromCampaigns: [1],
    lastSameEspInbox: null,
  };
}

describe("ClientFanOutService rest exclusion", () => {
  it("never fans out a mailbox that is resting", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "BCP PE", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "BCP Logistics", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 100,
          from_email: "rest@boldercyperpartnerbiz.info", created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [1],
          client_id: 9,
        },
        {
          id: 101,
          from_email: "healthy@boldercyperpartnerbiz.info", created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [1],
          client_id: 9,
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
      getHeldInbox: () => undefined,
      getDomainHistory: () => undefined,
      getRestingInbox: (email: string) =>
        email.toLowerCase() === "rest@boldercyperpartnerbiz.info"
          ? restRecord(email)
          : undefined,
    } as unknown as StateStore;

    const service = new ClientFanOutService(
      loadConfig({}),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false });
    const addedIds = adds.flatMap(([, ids]) => ids);
    assert.ok(!addedIds.includes(100), "rester must not be re-attached");
    assert.ok(addedIds.includes(101), "on-week mailbox should still fan out");
    assert.ok(
      result.skipped.some((s) => s.includes("rest@boldercyperpartnerbiz.info")),
    );
  });
});
