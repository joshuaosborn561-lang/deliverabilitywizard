import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { assignClientCohorts, isOffWeek } from "../lib/restCohort.js";
import { StateStore } from "../state/store.js";
import {
  ClientRestService,
  isExcludedOnlyMembership,
  isRestDetachableCampaign,
  pickExclusiveOnWeekTarget,
} from "./clientRest.js";

/** Old enough that owesWarmup is false under the 21-day clock. */
const WARMED = "2025-01-01T00:00:00.000Z";
/** Still inside the 21-day owe window relative to wall clock (owesWarmup uses Date.now). */
const YOUNG = new Date(Date.now() - 3 * 86_400_000).toISOString();

/**
 * Generic-pool seats that keep ACTIVE membership ≥40 so A/B rest can
 * still bench surplus. They count toward detach remaining but never
 * enter the client A/B split (isGenericMailbox).
 */
function heldMin40Pads(
  campaignIds: number[],
  _clientId: number,
  count = 40,
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: 9000 + i,
    from_email: `pad-${i}@crosslaunchco.com`,
    campaign_ids: campaignIds,
    created_at: WARMED,
    is_smtp_success: true,
    is_imap_success: true,
  }));
}

describe("isExcludedOnlyMembership", () => {
  it("does not treat a leftover campaign id as excluded (D63)", () => {
    const byId = new Map([
      [1, { id: 1, name: "Live BCP" }],
    ]);
    assert.equal(
      isExcludedOnlyMembership([9999], byId, ["msrs"]),
      false,
    );
    assert.equal(
      isExcludedOnlyMembership([1, 9999], byId, ["msrs"]),
      false,
    );
    assert.equal(
      isExcludedOnlyMembership([40], new Map([[40, { id: 40, name: "MSRS2" }]]), [
        "msrs",
      ]),
      true,
    );
  });
});

describe("isRestDetachableCampaign", () => {
  it("D169: PAUSED and STOPPED are detachable — ACTIVE-only bench was the bug", () => {
    assert.equal(
      isRestDetachableCampaign(
        { id: 1, name: "BCP No Team", status: "ACTIVE" },
        [],
      ),
      true,
    );
    assert.equal(
      isRestDetachableCampaign(
        { id: 2, name: "BCP With Team", status: "PAUSED" },
        [],
      ),
      true,
      "PAUSED still holds A/B inventory; off-week must come off it",
    );
    assert.equal(
      isRestDetachableCampaign(
        { id: 3, name: "Stopped client-named", status: "STOPPED" },
        [],
      ),
      true,
      "STOPPED still freezes inventory; off-week must come off it",
    );
    assert.equal(
      isRestDetachableCampaign(
        { id: 4, name: "Done", status: "COMPLETED" },
        [],
      ),
      false,
    );
    assert.equal(
      isRestDetachableCampaign(
        { id: 5, name: "Draft", status: "DRAFT" },
        [],
      ),
      false,
    );
    assert.equal(
      isRestDetachableCampaign(
        { id: 3841904, name: "Pod control shell", status: "PAUSED" },
        [],
      ),
      false,
      "shells stay out of rest detach",
    );
    assert.equal(
      isRestDetachableCampaign(
        { id: 40, name: "MSRS2", status: "PAUSED" },
        ["msrs"],
      ),
      false,
      "excluded campaigns stay out of rest detach",
    );
    assert.equal(isRestDetachableCampaign(undefined, []), false);
  });

  it("D189: ACTIVE Insight is not detachable; Engagers still are", () => {
    assert.equal(
      isRestDetachableCampaign(
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 345263,
        },
        [],
      ),
      false,
      "named Insight id stays attached",
    );
    assert.equal(
      isRestDetachableCampaign(
        {
          id: 4000001,
          name: "Insight Extra Lane",
          status: "ACTIVE",
          client_id: 345263,
        },
        [],
      ),
      false,
      "Insight name prefix on client 345263",
    );
    assert.equal(
      isRestDetachableCampaign(
        {
          id: 89,
          name: "SalesGlider Engagers",
          status: "ACTIVE",
          client_id: 345263,
        },
        [],
      ),
      true,
      "Engagers A/B rest is unchanged",
    );
    assert.equal(
      isRestDetachableCampaign(
        {
          id: 90,
          name: "Insight Other Client",
          status: "ACTIVE",
          client_id: 9,
        },
        [],
      ),
      true,
      "another client's Insight-named campaign still rests",
    );
    assert.equal(
      isRestDetachableCampaign(
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "PAUSED",
          client_id: 345263,
        },
        [],
      ),
      false,
      "paused Insight still sticky — D184 cannot restore once unlinked",
    );
  });
});

describe("isExcludedOnlyMembership", () => {
  it("does not treat the pod-control shell as the only excluded home (D72/D82)", () => {
    const byId = new Map([
      [1, { id: 1, name: "Live BCP" }],
      [3841904, { id: 3841904, name: "Pod control shell" }],
    ]);
    assert.equal(
      isExcludedOnlyMembership([3841904], byId, []),
      false,
    );
    assert.equal(
      isExcludedOnlyMembership([1, 3841904], byId, []),
      false,
    );
  });
});

describe("pickExclusiveOnWeekTarget", () => {
  it("D200: prefers an already-on target over a thinner unused camp", () => {
    assert.equal(
      pickExclusiveOnWeekTarget(
        [10, 20, 30],
        [20],
        new Map([
          [10, 41],
          [20, 50],
          [30, 42],
        ]),
      ),
      20,
    );
  });

  it("D200: idle generic picks the thinnest staffable camp; tie → lowest id", () => {
    assert.equal(
      pickExclusiveOnWeekTarget(
        [30, 10, 20],
        [],
        new Map([
          [10, 45],
          [20, 42],
          [30, 42],
        ]),
      ),
      20,
    );
  });

  it("D200: already-on extras pick the thinnest sitting camp, then lowest id", () => {
    assert.equal(
      pickExclusiveOnWeekTarget(
        [10, 20, 30],
        [10, 30],
        new Map([
          [10, 48],
          [20, 41],
          [30, 48],
        ]),
      ),
      10,
    );
  });
});

describe("ClientRestService", () => {
  it("removes the off-week half of one client's inboxes (D43)", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // block 0 → B off
    const emails = [
      "a@client.info",
      "b@client.info",
      "m@client.info",
      "z@client.info",
    ];
    const cohorts = assignClientCohorts(emails);
    const offEmails = emails.filter((email) => isOffWeek(cohorts.get(email)!, now));
    assert.ok(offEmails.length >= 1);

    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "Also", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        ...emails.map((from_email, index) => ({
          id: 10 + index,
          from_email,
          client_id: 9,
          campaign_ids: [1, 2],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        })),
        ...heldMin40Pads([1, 2], 9),
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    for (const email of offEmails) {
      assert.ok(
        result.benched.some((row) => row.email === email),
        `expected ${email} benched`,
      );
      assert.ok(state.getRestingInbox(email));
    }
    const onEmails = emails.filter((email) => !offEmails.includes(email));
    for (const email of onEmails) {
      assert.equal(state.getRestingInbox(email), undefined);
    }
    assert.ok(removed.length >= 1);
  });

  it("restores an on-week rester even with an old same-ESP miss (D59)", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "a@client.info";
    assert.equal(assignClientCohorts([onEmail, "z@client.info"]).get(onEmail), "A");
    assert.equal(isOffWeek("A", now), false);

    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-veto-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markRestingInbox({
      accountId: 20,
      email: onEmail,
      clientId: "id:9",
      cohort: "A",
      kind: "client",
      restingSince: "2025-12-01T00:00:00.000Z",
      removedFromCampaigns: [1],
      lastSameEspInbox: 35,
    });

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 9,
          campaign_ids: [],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: "z@client.info",
          client_id: 9,
          campaign_ids: [1],
          created_at: WARMED,
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.ok(adds.some((row) => row[0] === 1 && row[1].includes(20)));
    assert.equal(state.getRestingInbox(onEmail), undefined);
  });

  it("D176: on-week restore will not reattach an attach-blocked sender", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "burned@boldercyperpartnerhub.info";
    assert.equal(
      assignClientCohorts([onEmail, "z@boldercyperpartnerhub.info"]).get(onEmail),
      "A",
    );
    assert.equal(isOffWeek("A", now), false);

    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-attach-block-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertAttachBlock({
      domain: "boldercyperpartnerhub.info",
      emails: [onEmail],
      accountIds: [20],
      reason: "restricted",
      source: "campaign:3763800",
    });
    state.markRestingInbox({
      accountId: 20,
      email: onEmail,
      clientId: "id:9",
      cohort: "A",
      kind: "client",
      restingSince: "2025-12-01T00:00:00.000Z",
      removedFromCampaigns: [3763800],
    });

    const smartlead = {
      listCampaigns: async () => [
        { id: 3763800, name: "HC No Team", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 9,
          campaign_ids: [],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: "z@boldercyperpartnerhub.info",
          client_id: 9,
          campaign_ids: [3763800],
          created_at: WARMED,
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.ok(!adds.flatMap(([, ids]) => ids).includes(20));
    assert.ok(result.skipped.some((row) => row.includes("attach blocked")));
  });

  it("does not A/B-rest a pool generic (D43)", async () => {
    const now = new Date("2026-01-01T17:00:00Z");
    const state = new StateStore(
      `/tmp/client-rest-generic-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "generic@pool.info",
      domain: "pool.info",
      firstName: "Pool",
      lastName: "User",
      platform: "GOOGLE",
      status: "assigned",
      smartleadAccountId: 55,
      warmedAt: "2025-01-01T00:00:00.000Z",
      availableAt: "2025-01-15T00:00:00.000Z",
      prewarmed: true,
    });

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 55,
          from_email: "generic@pool.info",
          client_id: null,
          from_name: "Pool User",
          campaign_ids: [1],
          created_at: WARMED,
        },
        {
          id: 56,
          from_email: "keeper@client.info",
          client_id: 9,
          campaign_ids: [1],
          created_at: WARMED,
        },
      ],
      removeEmailAccountsFromCampaign: async () => {
        throw new Error("must not bench a generic from client rest");
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.equal(result.benched.length, 0);
    assert.equal(state.getRestingInbox("generic@pool.info"), undefined);
  });

  it("puts an on-week idle client back on the client's live campaigns (D44)", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const idle = "a@client.info";
    assert.equal(assignClientCohorts([idle, "z@client.info"]).get(idle), "A");
    assert.equal(isOffWeek("A", now), false);

    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-idle-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "Also", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: idle,
          client_id: 9,
          campaign_ids: [],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: "z@client.info",
          client_id: 9,
          campaign_ids: [1, 2],
          created_at: WARMED,
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.ok(
      result.restored.some((row) => row.email === idle),
      "idle on-week client must be restored",
    );
    assert.ok(adds.some((row) => row[0] === 1 && row[1].includes(20)));
    assert.ok(adds.some((row) => row[0] === 2 && row[1].includes(20)));
  });

  it("restores an on-week inbox that only has a leftover campaign id (D63)", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const idle = "a@client.info";
    assert.equal(assignClientCohorts([idle, "z@client.info"]).get(idle), "A");

    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-ghost-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: idle,
          client_id: 9,
          campaign_ids: [9999],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: "z@client.info",
          client_id: 9,
          campaign_ids: [1],
          created_at: WARMED,
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.ok(
      result.restored.some((row) => row.email === idle),
      "ghost campaign id must not skip restore",
    );
    assert.ok(adds.some((row) => row[0] === 1 && row[1].includes(20)));
  });

  it("restores an on-week inbox that is only on the pod-control shell (D72)", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const idle = "a@client.info";
    assert.equal(assignClientCohorts([idle, "z@client.info"]).get(idle), "A");

    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-shell-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE", client_id: 9 },
        { id: 3841904, name: "Pod control shell", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: idle,
          client_id: 9,
          campaign_ids: [3841904],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: "z@client.info",
          client_id: 9,
          campaign_ids: [1],
          created_at: WARMED,
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.ok(
      result.restored.some((row) => row.email === idle),
      "shell-only on-week inbox must be restored to live campaigns",
    );
    assert.ok(adds.some((row) => row[0] === 1 && row[1].includes(20)));
  });

  it("D154: does not put an under-warmed on-week inbox back on every client campaign", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const young = "a@client.info";
    assert.equal(assignClientCohorts([young, "z@client.info"]).get(young), "A");
    assert.equal(isOffWeek("A", now), false);

    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-young-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Parlay A", status: "ACTIVE", client_id: 5 },
        { id: 2, name: "Parlay B", status: "ACTIVE", client_id: 5 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: young,
          client_id: 5,
          campaign_ids: [],
          created_at: YOUNG,
          warmup_details: { created_at: YOUNG },
        },
        {
          id: 21,
          from_email: "z@client.info",
          client_id: 5,
          campaign_ids: [1, 2],
          created_at: WARMED,
          warmup_details: { created_at: WARMED },
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.equal(
      adds.filter((row) => row[1].includes(20)).length,
      0,
      "under-warmed on-week must not be re-added to client campaigns",
    );
    assert.ok(
      result.skipped.some((row) => row.includes("owes warmup")),
      "skip reason must name the warmup clock",
    );
    assert.equal(
      result.restored.some((row) => row.email === young),
      false,
    );
  });

  it("D169: benches off-week off PAUSED and STOPPED, not only ACTIVE", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // B off
    const emails = [
      "a@client.info",
      "b@client.info",
      "m@client.info",
      "z@client.info",
    ];
    const offEmails = emails.filter(
      (email) => isOffWeek(assignClientCohorts(emails).get(email)!, now),
    );
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-paused-bench-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "No Team", status: "ACTIVE", client_id: 542838 },
        { id: 2, name: "With Team", status: "PAUSED", client_id: 542838 },
        { id: 3, name: "Stopped client-named", status: "STOPPED", client_id: 542838 },
      ],
      listAllEmailAccounts: async () => [
        ...emails.map((from_email, index) => ({
          id: 10 + index,
          from_email,
          client_id: 542838,
          campaign_ids: [1, 2, 3],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        })),
        ...heldMin40Pads([1], 542838),
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    for (const email of offEmails) {
      const row = result.benched.find((entry) => entry.email === email);
      assert.ok(row, `expected ${email} benched`);
      assert.ok(row.campaignIds.includes(1), `${email} off ACTIVE`);
      assert.ok(row.campaignIds.includes(2), `${email} off PAUSED`);
      assert.ok(row.campaignIds.includes(3), `${email} off STOPPED`);
    }
    assert.ok(
      removed.some((row) => row[0] === 2),
      "must call remove on the PAUSED campaign",
    );
    assert.ok(
      removed.some((row) => row[0] === 3),
      "must call remove on the STOPPED campaign",
    );
  });

  it("D169: does not detach off-week from a shell or COMPLETED campaign", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // B off
    const emails = [
      "a@client.info",
      "b@client.info",
      "m@client.info",
      "z@client.info",
    ];
    const offEmails = emails.filter(
      (email) => isOffWeek(assignClientCohorts(emails).get(email)!, now),
    );
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-shell-bench-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "No Team", status: "ACTIVE", client_id: 9 },
        { id: 3841904, name: "Pod control shell", status: "PAUSED" },
        { id: 9, name: "Old run", status: "COMPLETED", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        ...emails.map((from_email, index) => ({
          id: 10 + index,
          from_email,
          client_id: 9,
          campaign_ids: [1, 3841904, 9],
          created_at: WARMED,
        })),
        ...heldMin40Pads([1], 9),
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    for (const email of offEmails) {
      const row = result.benched.find((entry) => entry.email === email);
      assert.ok(row, `expected ${email} benched from ACTIVE`);
      assert.ok(row.campaignIds.includes(1));
      assert.equal(row.campaignIds.includes(3841904), false);
      assert.equal(row.campaignIds.includes(9), false);
    }
    assert.equal(
      removed.some((row) => row[0] === 3841904 || row[0] === 9),
      false,
      "must not touch shell or COMPLETED",
    );
  });

  it("D169: on-week only on PAUSED still staffs every ACTIVE and clears PAUSED", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "a@client.info";
    assert.equal(assignClientCohorts([onEmail, "z@client.info"]).get(onEmail), "A");
    assert.equal(isOffWeek("A", now), false);

    const adds: Array<[number, number[]]> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-paused-restore-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "No Team", status: "ACTIVE", client_id: 542838 },
        { id: 2, name: "Also Active", status: "ACTIVE", client_id: 542838 },
        { id: 3, name: "With Team", status: "PAUSED", client_id: 542838 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 542838,
          campaign_ids: [3],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: "z@client.info",
          client_id: 542838,
          campaign_ids: [1, 2, 3],
          created_at: WARMED,
        },
        {
          id: 22,
          from_email: "m@client.info",
          client_id: 542838,
          campaign_ids: [3],
          created_at: WARMED,
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.ok(
      result.restored.some((row) => row.email === onEmail),
      "PAUSED-only on-week must restore onto ACTIVE",
    );
    assert.ok(adds.some((row) => row[0] === 1 && row[1].includes(20)));
    assert.ok(adds.some((row) => row[0] === 2 && row[1].includes(20)));
    assert.ok(
      removed.some((row) => row[0] === 3 && row[1].includes(20)),
      "on-week hygiene clears the PAUSED hoard",
    );
  });

  it("D169: on-week only on STOPPED still staffs every ACTIVE", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "a@client.info";
    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-stopped-restore-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "No Team", status: "ACTIVE", client_id: 9 },
        { id: 8, name: "Stopped generic", status: "STOPPED", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 9,
          campaign_ids: [8],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: "z@client.info",
          client_id: 9,
          campaign_ids: [1, 8],
          created_at: WARMED,
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.ok(
      result.restored.some((row) => row.email === onEmail),
      "STOPPED-only on-week must restore onto ACTIVE",
    );
    assert.ok(adds.some((row) => row[0] === 1 && row[1].includes(20)));
  });

  it("D169: a client-named BCP domain is not skipped as a generic", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "a@getboldercyperpartner.info";
    assert.equal(
      assignClientCohorts([onEmail, "z@getboldercyperpartner.info"]).get(onEmail),
      "A",
    );
    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-bcp-generic-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "BCP No Team", status: "ACTIVE", client_id: 542838 },
        { id: 2, name: "BCP With Team", status: "PAUSED", client_id: 542838 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 542838,
          from_name: "Harmony Norris",
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [2],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: "z@getboldercyperpartner.info",
          client_id: 542838,
          campaign_ids: [1, 2],
          created_at: WARMED,
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.ok(
      result.restored.some((row) => row.email === onEmail),
      "BCP-owned domain must stay in the A/B pod even with a GENERIC tag",
    );
    assert.ok(adds.some((row) => row[0] === 1 && row[1].includes(20)));
  });

  it("D169: last-account guard still holds on a PAUSED campaign", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // B off
    const offEmail = "z@client.info";
    assert.equal(isOffWeek("B", now), true);
    assert.equal(assignClientCohorts(["a@client.info", offEmail]).get(offEmail), "B");

    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-last-paused-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "No Team", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "With Team", status: "PAUSED", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: "a@client.info",
          client_id: 9,
          campaign_ids: [1],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: offEmail,
          client_id: 9,
          campaign_ids: [2],
          created_at: WARMED,
        },
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.equal(
      removed.some((row) => row[0] === 2),
      false,
      "must not empty the last account on a PAUSED campaign",
    );
    assert.ok(
      result.skipped.some((row) => row.includes("last account on #2")),
      "skip reason must name the last-account guard",
    );
  });

  it("D189: does not unlink off-week from ACTIVE Insight; Engagers still rest", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // B off
    const insightEmails = [
      "a@salesglidertop.org",
      "b@salesglidertop.org",
      "m@salesglidertop.org",
      "z@salesglidertop.org",
    ];
    const engagerEmails = [
      "c@salesglidergrowth.com",
      "d@salesglidergrowth.com",
      "n@salesglidergrowth.com",
      "y@salesglidergrowth.com",
    ];
    const emails = [...insightEmails, ...engagerEmails];
    const cohorts = assignClientCohorts(emails);
    const offEmails = emails.filter((email) => isOffWeek(cohorts.get(email)!, now));
    const offInsight = offEmails.filter((email) => insightEmails.includes(email));
    const offEngagers = offEmails.filter((email) => engagerEmails.includes(email));
    assert.ok(offInsight.length >= 1, "need an off-week exclusive Insight seat");
    assert.ok(offEngagers.length >= 1, "need an off-week Engagers seat");

    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-insight-sticky-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 345263,
        },
        {
          id: 4000001,
          name: "Insight Extra Lane",
          status: "ACTIVE",
          client_id: 345263,
        },
        {
          id: 89,
          name: "SalesGlider Engagers",
          status: "ACTIVE",
          client_id: 345263,
        },
      ],
      listAllEmailAccounts: async () => [
        ...emails.map((from_email, index) => ({
          id: 10 + index,
          from_email,
          client_id: 345263,
          campaign_ids: insightEmails.includes(from_email)
            ? [3921647, 4000001]
            : [89],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        })),
        ...heldMin40Pads([89], 345263),
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.equal(
      removed.some((row) => row[0] === 3921647 || row[0] === 4000001),
      false,
      "must not unlink exclusive Insight seats",
    );
    for (const email of offInsight) {
      assert.equal(
        result.benched.some((row) => row.email === email),
        false,
        `${email} exclusive Insight must not be benched`,
      );
      assert.equal(
        state.getRestingInbox(email),
        undefined,
        `${email} must not be marked resting while staying on Insight`,
      );
    }
    for (const email of offEngagers) {
      const row = result.benched.find((entry) => entry.email === email);
      assert.ok(row, `expected ${email} Engagers seat benched`);
      assert.ok(row.campaignIds.includes(89));
      assert.equal(row.campaignIds.includes(3921647), false);
      assert.ok(state.getRestingInbox(email));
    }
    assert.ok(
      removed.some((row) => row[0] === 89),
      "Engagers A/B rest is unchanged",
    );
  });

  it("D189: shared Insight+Engagers off-week leaves Insight, benches Engagers", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // B off
    const emails = [
      "a@salesglidertop.org",
      "b@salesglidertop.org",
      "m@salesglidertop.org",
      "z@salesglidertop.org",
    ];
    const offEmails = emails.filter(
      (email) => isOffWeek(assignClientCohorts(emails).get(email)!, now),
    );
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-insight-shared-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 345263,
        },
        {
          id: 89,
          name: "SalesGlider Engagers",
          status: "ACTIVE",
          client_id: 345263,
        },
      ],
      listAllEmailAccounts: async () => [
        ...emails.map((from_email, index) => ({
          id: 10 + index,
          from_email,
          client_id: 345263,
          campaign_ids: [3921647, 89],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        })),
        ...heldMin40Pads([89], 345263),
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.equal(
      removed.some((row) => row[0] === 3921647),
      false,
      "shared seat must stay on Insight",
    );
    for (const email of offEmails) {
      const row = result.benched.find((entry) => entry.email === email);
      assert.ok(row, `expected ${email} benched from Engagers`);
      assert.deepEqual(row.campaignIds, [89]);
    }
    assert.ok(
      removed.some((row) => row[0] === 89),
      "shared seat still benches off Engagers",
    );
  });

  it("D189: on-week exclusive Insight is not re-POSTed onto Insight or Engagers", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const insightOn = "a@salesglidertop.org";
    const engagerOn = "b@salesglidertop.org";
    const emails = [insightOn, engagerOn, "m@salesglidertop.org", "z@salesglidertop.org"];
    assert.equal(assignClientCohorts(emails).get(insightOn), "A");
    assert.equal(isOffWeek("A", now), false);

    const adds: Array<[number, number[]]> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-insight-onweek-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 345263,
        },
        {
          id: 89,
          name: "SalesGlider Engagers",
          status: "ACTIVE",
          client_id: 345263,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: insightOn,
          client_id: 345263,
          campaign_ids: [3921647],
          created_at: WARMED,
        },
        {
          id: 21,
          from_email: engagerOn,
          client_id: 345263,
          campaign_ids: [89],
          created_at: WARMED,
        },
        {
          id: 22,
          from_email: "m@salesglidertop.org",
          client_id: 345263,
          campaign_ids: [3921647],
          created_at: WARMED,
        },
        {
          id: 23,
          from_email: "z@salesglidertop.org",
          client_id: 345263,
          campaign_ids: [89],
          created_at: WARMED,
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false, now });
    assert.equal(
      adds.some((row) => row[0] === 3921647 && row[1].includes(20)),
      false,
      "already-on Insight must not be re-attached",
    );
    assert.equal(
      adds.some((row) => row[0] === 89 && row[1].includes(20)),
      false,
      "exclusive Insight must not fan onto Engagers",
    );
    assert.equal(
      removed.some((row) => row[0] === 3921647),
      false,
      "on-week must not detach Insight",
    );
    assert.ok(
      result.skipped.some((row) =>
        row.includes("Insight / ACTIVE SalesGlider staffing split"),
      ),
      "D184 split still blocks Insight → Engagers on restore",
    );
  });

  it("D197: does not bench off-week named seats when ACTIVE is at 40", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // B off
    const emails = Array.from(
      { length: 40 },
      (_, i) => `seat-${String(i).padStart(2, "0")}@client.info`,
    );
    const offEmails = emails.filter(
      (email) => isOffWeek(assignClientCohorts(emails).get(email)!, now),
    );
    assert.ok(offEmails.length >= 1, "need off-week seats to prove the skip");

    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-min40-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Parlay Sports", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () =>
        emails.map((from_email, index) => ({
          id: 10 + index,
          from_email,
          client_id: 9,
          campaign_ids: [1],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        })),
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const result = await service.run({ dryRun: false, now });
    assert.deepEqual(removed, []);
    for (const email of offEmails) {
      assert.equal(
        result.benched.some((row) => row.email === email),
        false,
        `${email} must stay — peeling would drop Parlay below 40`,
      );
    }
    assert.ok(result.skipped.some((row) => row.includes("on-week min 40")));
  });

  it("D198: dedicated named-client generics rest with that client's A/B pods", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "ada@trygetintroduced.info";
    assert.equal(assignClientCohorts([onEmail, "zoe@trygetintroduced.info"]).get(onEmail), "A");
    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-d198-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: onEmail,
      domain: "trygetintroduced.info",
      firstName: "Ada",
      lastName: "Pool",
      platform: "GOOGLE",
      status: "assigned",
      smartleadAccountId: 20,
      assignedClientId: 77,
    });

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Parlay Sports", status: "ACTIVE", client_id: 77 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 77,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 21,
          from_email: "zoe@trygetintroduced.info",
          client_id: 77,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [1],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 77, name: "Parlay", logo: "Parlay" },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const result = await service.run({ dryRun: false, now });
    assert.ok(
      result.restored.some((row) => row.email === onEmail),
      "dedicated Parlay generic must join the on-week pod, not be skipped as rotating pool",
    );
    assert.ok(adds.some((row) => row[0] === 1 && row[1].includes(20)));
  });

  it("D199: disconnected leftovers must not let off-week rest drop staffable below 40", async () => {
    const now = new Date("2026-01-15T17:00:00Z"); // B on
    const emails = Array.from(
      { length: 40 },
      (_, i) => `seat-${String(i).padStart(2, "0")}@client.info`,
    );
    const offEmails = emails.filter(
      (email) => isOffWeek(assignClientCohorts(emails).get(email)!, now),
    );
    assert.ok(offEmails.length >= 1, "need off-week seats to prove the skip");

    const removedIds: number[] = [];
    const state = new StateStore(
      `/tmp/client-rest-d199-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const staffable = emails.map((from_email, index) => ({
      id: 10 + index,
      from_email,
      client_id: 9,
      campaign_ids: [1],
      created_at: WARMED,
      is_smtp_success: true,
      is_imap_success: true,
    }));
    const zombies = Array.from({ length: 32 }, (_, i) => ({
      id: 200 + i,
      from_email: `dead-${String(i).padStart(2, "0")}@client.info`,
      client_id: 9,
      campaign_ids: [1],
      created_at: WARMED,
      is_smtp_success: false,
    }));
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Parlay Sports", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [...staffable, ...zombies],
      listClients: async () => [{ id: 9, name: "Parlay", logo: "Parlay" }],
      removeEmailAccountsFromCampaign: async (
        _campaignId: number,
        ids: number[],
      ) => {
        removedIds.push(...ids);
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const result = await service.run({ dryRun: false, now });
    const peeledStaffable = removedIds.filter((id) => id >= 10 && id < 50);
    assert.deepEqual(
      peeledStaffable,
      [],
      "D199 — 32 disconnected must not look like surplus that can bench on-week staffable seats",
    );
    for (const email of offEmails) {
      assert.equal(
        result.benched.some((row) => row.email === email),
        false,
        `${email} must stay — peeling would drop Parlay staffable below 40`,
      );
    }
  });

  it("D200: dedicated generic on-week restore attaches exactly one ACTIVE (already-on)", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "ada@trygetintroduced.info";
    assert.equal(
      assignClientCohorts([onEmail, "zoe@trygetintroduced.info"]).get(onEmail),
      "A",
    );
    const adds: Array<[number, number[]]> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-d200-already-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: onEmail,
      domain: "trygetintroduced.info",
      firstName: "Ada",
      lastName: "Pool",
      platform: "GOOGLE",
      status: "assigned",
      smartleadAccountId: 20,
      assignedClientId: 521881,
    });

    const smartlead = {
      listCampaigns: async () => [
        { id: 3847798, name: "TechEvo A", status: "ACTIVE", client_id: 521881 },
        { id: 3847801, name: "TechEvo B", status: "ACTIVE", client_id: 521881 },
        { id: 3847804, name: "TechEvo C", status: "ACTIVE", client_id: 521881 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 521881,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [3847801],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 21,
          from_email: "zoe@trygetintroduced.info",
          client_id: 521881,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [3847798],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
        ...heldMin40Pads([3847798, 3847801, 3847804], 521881),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 521881, name: "TechEvo", logo: "TechEvolution" },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    await service.run({ dryRun: false, now });
    assert.equal(
      adds.filter((row) => row[1].includes(20)).length,
      0,
      "already-on exclusive generic must not fan onto the other TechEvo camps",
    );
    assert.equal(
      removed.some((row) => row[1].includes(20) && row[0] === 3847801),
      false,
      "must keep the already-on exclusive camp",
    );
  });

  it("D200: idle dedicated generic attaches only the thinnest ACTIVE (tie → lowest id)", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "ada@trygetintroduced.info";
    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-d200-thin-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: onEmail,
      domain: "trygetintroduced.info",
      firstName: "Ada",
      lastName: "Pool",
      platform: "GOOGLE",
      status: "assigned",
      smartleadAccountId: 20,
      assignedClientId: 521881,
    });

    const smartlead = {
      listCampaigns: async () => [
        { id: 3847804, name: "TechEvo C", status: "ACTIVE", client_id: 521881 },
        { id: 3847798, name: "TechEvo A", status: "ACTIVE", client_id: 521881 },
        { id: 3847801, name: "TechEvo B", status: "ACTIVE", client_id: 521881 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 521881,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 21,
          from_email: "zoe@trygetintroduced.info",
          client_id: 521881,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [3847798],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
        ...heldMin40Pads([3847798], 521881, 48),
        ...heldMin40Pads([3847801], 521881, 42).map((row, i) => ({
          ...row,
          id: 9200 + i,
        })),
        ...heldMin40Pads([3847804], 521881, 42).map((row, i) => ({
          ...row,
          id: 9400 + i,
        })),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 521881, name: "TechEvo", logo: "TechEvolution" },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const result = await service.run({ dryRun: false, now });
    const adaAdds = adds.filter((row) => row[1].includes(20)).map((row) => row[0]);
    assert.deepEqual(
      adaAdds,
      [3847801],
      "idle exclusive generic must attach the thinnest camp; 3847801 beats 3847804 on id",
    );
    assert.ok(result.restored.some((row) => row.email === onEmail));
  });

  it("D200: dedicated generic already on two ACTIVE camps peels the extra above the floor", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "ada@trygetintroduced.info";
    const adds: Array<[number, number[]]> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-d200-peel-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: onEmail,
      domain: "trygetintroduced.info",
      firstName: "Ada",
      lastName: "Pool",
      platform: "GOOGLE",
      status: "assigned",
      smartleadAccountId: 20,
      assignedClientId: 521881,
    });

    const smartlead = {
      listCampaigns: async () => [
        { id: 3847798, name: "TechEvo A", status: "ACTIVE", client_id: 521881 },
        { id: 3847801, name: "TechEvo B", status: "ACTIVE", client_id: 521881 },
        { id: 3, name: "TechEvo paused", status: "PAUSED", client_id: 521881 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 521881,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [3847798, 3847801, 3],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 21,
          from_email: "zoe@trygetintroduced.info",
          client_id: 521881,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 22,
          from_email: "keep-paused@techevolution.com",
          client_id: 521881,
          campaign_ids: [3],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
        ...heldMin40Pads([3847798], 521881, 48),
        ...heldMin40Pads([3847801], 521881, 48).map((row, i) => ({
          ...row,
          id: 9200 + i,
        })),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 521881, name: "TechEvo", logo: "TechEvolution" },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    await service.run({ dryRun: false, now });
    assert.equal(
      adds.filter((row) => row[1].includes(20)).length,
      0,
      "already-on exclusive generic must not add a third camp",
    );
    const adaRemoved = removed
      .filter((row) => row[1].includes(20))
      .map((row) => row[0])
      .sort((a, b) => a - b);
    assert.ok(
      adaRemoved.includes(3847801),
      "must peel the extra same-client ACTIVE (thicker / higher id)",
    );
    assert.ok(adaRemoved.includes(3), "D169 hygiene still clears PAUSED");
    assert.equal(
      adaRemoved.includes(3847798),
      false,
      "must keep the chosen exclusive ACTIVE",
    );
  });

  it("D200: named client seats still restore onto every ACTIVE (D59/D169)", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // A on
    const onEmail = "corey@techevolution.com";
    assert.equal(
      assignClientCohorts([onEmail, "zoe@techevolution.com"]).get(onEmail),
      "A",
    );
    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-d200-named-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const smartlead = {
      listCampaigns: async () => [
        { id: 3847798, name: "TechEvo A", status: "ACTIVE", client_id: 521881 },
        { id: 3847801, name: "TechEvo B", status: "ACTIVE", client_id: 521881 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 20,
          from_email: onEmail,
          client_id: 521881,
          campaign_ids: [3847798],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 21,
          from_email: "zoe@techevolution.com",
          client_id: 521881,
          campaign_ids: [3847798, 3847801],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
        },
      ],
      listClients: async () => [
        { id: 521881, name: "TechEvo", logo: "TechEvolution" },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    await service.run({ dryRun: false, now });
    assert.ok(
      adds.some((row) => row[0] === 3847801 && row[1].includes(20)),
      "named techevolution* still multi-attaches every ACTIVE (D59)",
    );
    assert.equal(
      adds.some((row) => row[0] === 3847798 && row[1].includes(20)),
      false,
      "already-on named seat is not re-POSTed",
    );
  });
});
