import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type {
  PoolMailboxRecord,
  StateStore,
} from "../state/store.js";
import { CampaignTopUpService, espFillOrder, isExcluded } from "./campaignTopUp.js";

describe("espFillOrder", () => {
  it("prefers the ESP that is short of the 30% floor (D43)", () => {
    assert.deepEqual(espFillOrder({ GOOGLE: 40, MICROSOFT: 5 }, 50, 30), [
      "MICROSOFT",
      "GOOGLE",
    ]);
    assert.deepEqual(espFillOrder({ GOOGLE: 4, MICROSOFT: 40 }, 50, 30), [
      "GOOGLE",
      "MICROSOFT",
    ]);
  });
});

describe("isExcluded", () => {
  const msrs = { id: 3628940, name: "MSRS2 Ticket Offer Property Manager" };
  const parlay = { id: 3628957, name: "Parlay2 Sports Offer" };

  it("excludes nothing when no patterns are configured", () => {
    assert.equal(isExcluded(msrs, []), false);
  });

  it("always excludes the paused pod-control shell (D56)", () => {
    assert.equal(
      isExcluded({ id: 99, name: "Pod control shell" }, []),
      true,
    );
  });

  it("matches a name fragment case-insensitively", () => {
    assert.equal(isExcluded(msrs, ["msrs"]), true);
    assert.equal(isExcluded(msrs, ["MSRS"]), true);
    assert.equal(isExcluded(parlay, ["msrs"]), false);
  });

  it("matches an exact campaign id", () => {
    assert.equal(isExcluded(msrs, ["3628940"]), true);
    assert.equal(isExcluded(parlay, ["3628940"]), false);
  });

  it("does not treat an id as a substring of another id", () => {
    // "628940" must not knock out 3628940 by accident.
    assert.equal(isExcluded(msrs, ["628940"]), false);
  });

  it("ignores blank patterns", () => {
    assert.equal(isExcluded(msrs, ["", "   "]), false);
  });

  it("handles a missing campaign name", () => {
    assert.equal(isExcluded({ id: 1, name: null }, ["msrs"]), false);
    assert.equal(isExcluded({ id: 1, name: null }, ["1"]), true);
  });
});

function fakeSlack(): SlackClient {
  return { send: async () => undefined } as unknown as SlackClient;
}

function fakeState(
  pool: PoolMailboxRecord,
  activeSwapPoolEmails: string[] = [],
): { state: StateStore; current: () => PoolMailboxRecord } {
  let current = { ...pool };
  const state = {
    listPoolMailboxes: () => [current],
    listActiveSwaps: () =>
      activeSwapPoolEmails.map((poolEmail, index) => ({
        originalEmail: `original-${index}@client.info`,
        originalAccountId: 1000 + index,
        poolEmail,
        poolAccountId: current.smartleadAccountId!,
        clientId: 1,
        clientName: "Client",
        campaignIds: [1],
        swappedAt: new Date().toISOString(),
        poolPlatform: current.platform,
      })),
    findReassignablePoolMailbox: (
      platforms: Array<"GOOGLE" | "MICROSOFT">,
      canTake: (email: string) => boolean,
    ) =>
      platforms.includes(current.platform) &&
      ["available", "assigned"].includes(current.status) &&
      canTake(current.email)
        ? current
        : undefined,
    upsertPoolMailbox: (record: PoolMailboxRecord) => {
      current = { ...record };
    },
    getHeldInbox: () => undefined,
    getRestingInbox: () => undefined,
    isCopyCanary: () => false,
    hasPendingResume: () => false,
    listPendingResumes: () => [],
    save: async () => undefined,
  } as unknown as StateStore;
  return { state, current: () => current };
}

describe("CampaignTopUpService safety", () => {
  it("never selects a generic dedicated to an active recovery swap", async () => {
    const pool: PoolMailboxRecord = {
      email: "swap@pool.info",
      domain: "pool.info",
      platform: "GOOGLE",
      smartleadAccountId: 10,
      firstName: "Swap",
      lastName: "Sender",
      status: "assigned",
    };
    const { state } = fakeState(pool, [pool.email]);
    let addCalls = 0;
    const smartlead = {
      listCampaigns: async () => [
        { id: 2, name: "Thin", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 10,
          from_email: pool.email,
          from_name: "Swap Sender",
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [],
        },
      ],
      listClients: async () => [{ id: 2, name: "Client B" }],
      addEmailAccountsToCampaign: async () => {
        addCalls += 1;
      },
    } as unknown as SmartleadClient;
    const service = new CampaignTopUpService(
      loadConfig({ MIN_CAMPAIGN_SENDERS: "50" }),
      smartlead,
      fakeSlack(),
      state,
    );

    const result = await service.run();
    assert.equal(addCalls, 0);
    assert.equal(result.assigned.length, 0);
    assert.equal(result.unfilled[0]?.shortBy, 50);
  });

  it("ignores disconnected membership when measuring the floor", async () => {
    const pool: PoolMailboxRecord = {
      email: "free@pool.info",
      domain: "pool.info",
      platform: "GOOGLE",
      smartleadAccountId: 10,
      firstName: "Free",
      lastName: "Sender",
      status: "available",
    };
    const { state } = fakeState(pool);
    let addCalls = 0;
    const smartlead = {
      listCampaigns: async () => [
        { id: 2, name: "Thin", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 10,
          from_email: pool.email,
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [],
        },
        ...Array.from({ length: 49 }, (_, index) => ({
          id: 200 + index,
          from_email: `dead-${index}@x.com`,
          type: "GMAIL",
          is_smtp_success: false,
          is_imap_success: false,
          campaign_ids: [2],
        })),
      ],
      listClients: async () => [{ id: 2, name: "Client B" }],
      addEmailAccountsToCampaign: async () => {
        addCalls += 1;
      },
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;
    const service = new CampaignTopUpService(
      loadConfig({ MIN_CAMPAIGN_SENDERS: "50" }),
      smartlead,
      fakeSlack(),
      state,
    );

    const result = await service.run();
    assert.equal(addCalls, 1);
    assert.equal(result.assigned.length, 1);
    // 49 disconnected + 1 placed still leaves shortfall of 49 staffable.
    assert.equal(result.unfilled[0]?.shortBy, 49);
  });

  it("keeps the first assignedAt so the generic sit clock does not reset", async () => {
    const started = "2026-01-01T00:00:00.000Z";
    const pool: PoolMailboxRecord = {
      email: "clock@crosslaunchco.com",
      domain: "crosslaunchco.com",
      platform: "GOOGLE",
      smartleadAccountId: 10,
      firstName: "Clock",
      lastName: "Sender",
      status: "assigned",
      assignedAt: started,
    };
    const { state, current } = fakeState(pool);
    const smartlead = {
      listCampaigns: async () => [
        { id: 2, name: "Thin", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 10,
          from_email: pool.email,
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [],
        },
      ],
      listClients: async () => [{ id: 2, name: "Client B" }],
      addEmailAccountsToCampaign: async () => undefined,
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;
    const service = new CampaignTopUpService(
      loadConfig({ MIN_CAMPAIGN_SENDERS: "50" }),
      smartlead,
      fakeSlack(),
      state,
    );

    const result = await service.run();
    assert.equal(result.assigned.length, 1);
    assert.equal(current().assignedAt, started);
  });

  it("rolls back donor and target membership before retrying a failed move", async () => {
    const pool: PoolMailboxRecord = {
      email: "move@pool.info",
      domain: "pool.info",
      platform: "GOOGLE",
      smartleadAccountId: 10,
      firstName: "Move",
      lastName: "Sender",
      status: "assigned",
      assignedClientId: 1,
    };
    const { state, current } = fakeState(pool);
    const donorAccounts = Array.from({ length: 50 }, (_, index) => ({
      id: 100 + index,
      from_email: `donor-${index}@client-a.info`,
      type: "GMAIL",
      campaign_ids: [1],
    }));
    const events: string[] = [];
    let brandingAttempts = 0;
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Donor", status: "ACTIVE", client_id: 1 },
        { id: 2, name: "Receiver", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 10,
          from_email: pool.email,
          from_name: "Old Sender",
          signature: "Old signature",
          client_id: 1,
          type: "GMAIL",
          campaign_ids: [1],
        },
        ...donorAccounts,
      ],
      listClients: async () => [
        { id: 1, name: "Client A" },
        { id: 2, name: "Client B" },
      ],
      addEmailAccountsToCampaign: async (campaignId: number) => {
        events.push(`add:${campaignId}`);
      },
      removeEmailAccountsFromCampaign: async (campaignId: number) => {
        events.push(`remove:${campaignId}`);
      },
      updateEmailAccount: async (
        _accountId: number,
        fields: { signature?: string },
      ) => {
        events.push(`identity:${fields.signature}`);
        if (fields.signature !== "Old signature" && brandingAttempts++ === 0) {
          throw new Error("transient branding failure");
        }
      },
    } as unknown as SmartleadClient;
    const service = new CampaignTopUpService(
      loadConfig({ MIN_CAMPAIGN_SENDERS: "50" }),
      smartlead,
      fakeSlack(),
      state,
    );

    const result = await service.run();
    assert.deepEqual(events.slice(0, 6), [
      "add:2",
      "remove:1",
      "identity:Move Sender\nClient B",
      "remove:2",
      "add:1",
      "identity:Old signature",
    ]);
    assert.equal(
      events.filter((event) => event === "add:2").length,
      2,
      "move should retry only after the first attempt was compensated",
    );
    assert.equal(result.assigned.length, 1);
    assert.equal(result.assigned[0]?.movedFrom[0], 1);
    assert.equal(current().assignedClientId, 2);
    assert.equal(current().status, "assigned");
  });
});
