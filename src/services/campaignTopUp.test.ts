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

  it("always excludes a paused canary shell (D114)", () => {
    assert.equal(
      isExcluded({ id: 88, name: "Canary shell: #3479011 Parlay Sports Offer" }, []),
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
): { state: StateStore; current: () => PoolMailboxRecord } {
  let current = { ...pool };
  const state = {
    listPoolMailboxes: () => [current],
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
    getRestingInbox: () => undefined,
    getPoolMailbox: () => undefined,
    getDomainHistory: () => undefined,
    clearGenericSendStartedAt: () => undefined,
    isCopyCanary: () => false,
    hasPendingResume: () => false,
    listPendingResumes: () => [],
    save: async () => undefined,
  } as unknown as StateStore;
  return { state, current: () => current };
}

describe("CampaignTopUpService safety", () => {
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
        { id: 2, name: "Goliath Thin", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 10,
          from_email: pool.email,
          created_at: "2026-06-01T00:00:00Z",
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [],
        },
        ...Array.from({ length: 49 }, (_, index) => ({
          id: 200 + index,
          from_email: `dead-${index}@x.com`,
          created_at: "2026-06-01T00:00:00Z",
          client_id: 2,
          type: "GMAIL",
          is_smtp_success: false,
          is_imap_success: false,
          campaign_ids: [2],
        })),
        ...Array.from({ length: 51 }, (_, index) => ({
          id: 400 + index,
          from_email: `live-${index}@goliath.com`,
          created_at: "2026-06-01T00:00:00Z",
          client_id: 2,
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [],
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
    // 100 client inboxes → floor 50. 49 disconnected + 1 placed ⇒ short 49.
    assert.equal(result.unfilled[0]?.shortBy, 49);
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
      created_at: "2026-06-01T00:00:00Z",
      type: "GMAIL",
      campaign_ids: [1],
    }));
    const events: string[] = [];
    let brandingAttempts = 0;
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Goliath Donor", status: "ACTIVE", client_id: 1 },
        { id: 2, name: "Goliath Receiver", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 10,
          from_email: pool.email,
          created_at: "2026-06-01T00:00:00Z",
          from_name: "Old Sender",
          signature: "Old signature",
          client_id: 1,
          type: "GMAIL",
          campaign_ids: [1],
        },
        ...donorAccounts,
        ...Array.from({ length: 100 }, (_, index) => ({
          id: 500 + index,
          from_email: `goliath-${index}@client-b.info`,
          created_at: "2026-06-01T00:00:00Z",
          client_id: 2,
          type: "GMAIL",
          campaign_ids: [],
        })),
      ],
      listClients: async () => [
        { id: 1, name: "Goliath A" },
        { id: 2, name: "Goliath B" },
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
      "identity:Move Sender\nGoliath B",
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

  it("pulls generics off non-Goliath campaigns and will not restaff them", async () => {
    const pool: PoolMailboxRecord = {
      email: "spare@crosslaunchco.com",
      domain: "crosslaunchco.com",
      platform: "GOOGLE",
      smartleadAccountId: 10,
      firstName: "Spare",
      lastName: "Sender",
      status: "assigned",
    };
    const { state } = fakeState(pool);
    const removed: number[][] = [];
    let addCalls = 0;
    const smartlead = {
      listCampaigns: async () => [
        { id: 2, name: "Vasco - Service", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 10,
          from_email: pool.email,
          created_at: "2026-06-01T00:00:00Z",
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [2],
        },
        ...Array.from({ length: 80 }, (_, index) => ({
          id: 100 + index,
          from_email: `vasco-${index}@vasco.com`,
          created_at: "2026-06-01T00:00:00Z",
          client_id: 9,
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [2],
        })),
      ],
      listClients: async () => [{ id: 9, name: "Vasco Warranty" }],
      addEmailAccountsToCampaign: async () => {
        addCalls += 1;
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push(ids);
        void campaignId;
      },
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;
    const service = new CampaignTopUpService(
      loadConfig({ MIN_CAMPAIGN_SENDERS: "50" }),
      smartlead,
      fakeSlack(),
      state,
    );

    const result = await service.run();
    assert.deepEqual(removed.flat(), [10]);
    assert.equal(addCalls, 0);
    assert.equal(result.pulledGenerics[0]?.email, pool.email);
    assert.equal(result.assigned.length, 0);
  });

  it("D176: will not restaff an attach-blocked generic onto a short campaign", async () => {
    const pool: PoolMailboxRecord = {
      email: "ada@cleartechco.com",
      domain: "cleartechco.com",
      platform: "GOOGLE",
      smartleadAccountId: 42004,
      firstName: "Ada",
      lastName: "Clear",
      status: "available",
    };
    const { state } = fakeState(pool);
    const blockedState = {
      ...state,
      listAttachBlocks: () => [
        {
          domain: "cleartechco.com",
          emails: [pool.email],
          accountIds: [42004],
          reason: "sender_blocked" as const,
          blockedAt: "2026-09-03T20:23:00.000Z",
        },
      ],
      listIsolationActions: () => [],
    } as unknown as StateStore;
    let addCalls = 0;
    const smartlead = {
      listCampaigns: async () => [
        { id: 3851730, name: "Goliath MDR", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 42004,
          from_email: pool.email,
          created_at: "2026-06-01T00:00:00Z",
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [],
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: 500 + index,
          from_email: `live-${index}@goliath.com`,
          created_at: "2026-06-01T00:00:00Z",
          client_id: 2,
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [],
        })),
      ],
      listClients: async () => [{ id: 2, name: "Goliath Cybersecurity" }],
      addEmailAccountsToCampaign: async () => {
        addCalls += 1;
      },
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;
    const service = new CampaignTopUpService(
      loadConfig({}),
      smartlead,
      fakeSlack(),
      blockedState,
    );

    const result = await service.run();
    assert.equal(addCalls, 0, "blocked cleartechco must not fill the gap");
    assert.equal(result.assigned.length, 0);
  });
});
