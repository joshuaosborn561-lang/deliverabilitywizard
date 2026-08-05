import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type {
  PoolMailboxRecord,
  StateStore,
} from "../state/store.js";
import { CampaignTopUpService, isExcluded } from "./campaignTopUp.js";

describe("isExcluded", () => {
  const msrs = { id: 3628940, name: "MSRS2 Ticket Offer Property Manager" };
  const parlay = { id: 3628957, name: "Parlay2 Sports Offer" };

  it("excludes nothing when no patterns are configured", () => {
    assert.equal(isExcluded(msrs, []), false);
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

function fakeStateMultiPool(mailboxes: PoolMailboxRecord[]): {
  state: StateStore;
  assignedPlatforms: () => Array<"GOOGLE" | "MICROSOFT">;
} {
  const byEmail = new Map(mailboxes.map((m) => [m.email.toLowerCase(), { ...m }]));
  const assignedPlatforms: Array<"GOOGLE" | "MICROSOFT"> = [];
  const state = {
    listPoolMailboxes: () => [...byEmail.values()],
    listActiveSwaps: () => [],
    findReassignablePoolMailbox: (
      platforms: Array<"GOOGLE" | "MICROSOFT">,
      canTake: (email: string) => boolean,
    ) => {
      for (const platform of platforms) {
        for (const m of byEmail.values()) {
          if (
            m.platform === platform &&
            ["available", "assigned"].includes(m.status) &&
            canTake(m.email)
          ) {
            return m;
          }
        }
      }
      return undefined;
    },
    upsertPoolMailbox: (record: PoolMailboxRecord) => {
      byEmail.set(record.email.toLowerCase(), { ...record });
      assignedPlatforms.push(record.platform);
    },
    save: async () => undefined,
  } as unknown as StateStore;
  return { state, assignedPlatforms: () => assignedPlatforms };
}

describe("CampaignTopUpService — D22 Gmail/Outlook ratio targeting", () => {
  it("fills a thin campaign toward the configured Gmail ratio, not whatever the pool happens to list first", async () => {
    // Deliberately list Outlook first and in far greater supply, matching
    // the real pool's actual composition (785 Outlook vs 310 Gmail) - if
    // targeting were broken, the campaign would come out Outlook-heavy.
    const mailboxes: PoolMailboxRecord[] = [
      ...Array.from({ length: 20 }, (_, i) => ({
        email: `outlook-${i}@pool.info`,
        domain: "pool.info",
        platform: "MICROSOFT" as const,
        smartleadAccountId: 100 + i,
        firstName: "Pool",
        lastName: `Outlook${i}`,
        status: "available" as const,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        email: `gmail-${i}@pool.info`,
        domain: "pool.info",
        platform: "GOOGLE" as const,
        smartleadAccountId: 200 + i,
        firstName: "Pool",
        lastName: `Gmail${i}`,
        status: "available" as const,
      })),
    ];
    const { state, assignedPlatforms } = fakeStateMultiPool(mailboxes);

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Thin", status: "ACTIVE", client_id: 1 },
      ],
      listAllEmailAccounts: async () =>
        mailboxes.map((m) => ({
          id: m.smartleadAccountId,
          from_email: m.email,
          type: m.platform === "GOOGLE" ? "GMAIL" : "OUTLOOK",
          campaign_ids: [],
        })),
      listClients: async () => [{ id: 1, name: "Client A" }],
      addEmailAccountsToCampaign: async () => undefined,
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new CampaignTopUpService(
      loadConfig({ MIN_CAMPAIGN_SENDERS: "10", TARGET_GMAIL_RATIO: "0.6" }),
      smartlead,
      fakeSlack(),
      state,
    );

    const result = await service.run();
    assert.equal(result.assigned.length, 10);
    const placed = assignedPlatforms();
    const googleCount = placed.filter((p) => p === "GOOGLE").length;
    const microsoftCount = placed.filter((p) => p === "MICROSOFT").length;
    assert.equal(googleCount, 6, `expected 6 Gmail (60% of 10), got ${googleCount}`);
    assert.equal(microsoftCount, 4, `expected 4 Outlook (40% of 10), got ${microsoftCount}`);
  });

  it("keeps filling from whichever platform still has supply once the other runs out", async () => {
    // Only 2 Gmail available against a need of 10 at a 60% target (needs 6).
    // The shortfall should not block Outlook fill for the rest.
    const mailboxes: PoolMailboxRecord[] = [
      ...Array.from({ length: 2 }, (_, i) => ({
        email: `gmail-${i}@pool.info`,
        domain: "pool.info",
        platform: "GOOGLE" as const,
        smartleadAccountId: 200 + i,
        firstName: "Pool",
        lastName: `Gmail${i}`,
        status: "available" as const,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        email: `outlook-${i}@pool.info`,
        domain: "pool.info",
        platform: "MICROSOFT" as const,
        smartleadAccountId: 100 + i,
        firstName: "Pool",
        lastName: `Outlook${i}`,
        status: "available" as const,
      })),
    ];
    const { state, assignedPlatforms } = fakeStateMultiPool(mailboxes);

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Thin", status: "ACTIVE", client_id: 1 },
      ],
      listAllEmailAccounts: async () =>
        mailboxes.map((m) => ({
          id: m.smartleadAccountId,
          from_email: m.email,
          type: m.platform === "GOOGLE" ? "GMAIL" : "OUTLOOK",
          campaign_ids: [],
        })),
      listClients: async () => [{ id: 1, name: "Client A" }],
      addEmailAccountsToCampaign: async () => undefined,
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new CampaignTopUpService(
      loadConfig({ MIN_CAMPAIGN_SENDERS: "10", TARGET_GMAIL_RATIO: "0.6" }),
      smartlead,
      fakeSlack(),
      state,
    );

    const result = await service.run();
    assert.equal(result.assigned.length, 10, "still fills to the floor despite Gmail shortage");
    const placed = assignedPlatforms();
    assert.equal(placed.filter((p) => p === "GOOGLE").length, 2, "used all available Gmail");
    assert.equal(placed.filter((p) => p === "MICROSOFT").length, 8, "backfilled the rest with Outlook");
  });
});
