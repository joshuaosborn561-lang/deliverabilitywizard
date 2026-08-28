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
} from "./clientRest.js";

/** Old enough that owesWarmup is false under the 21-day clock. */
const WARMED = "2025-01-01T00:00:00.000Z";
/** Still inside the 21-day owe window relative to wall clock (owesWarmup uses Date.now). */
const YOUNG = new Date(Date.now() - 3 * 86_400_000).toISOString();

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
      listAllEmailAccounts: async () =>
        emails.map((from_email, index) => ({
          id: 10 + index,
          from_email,
          client_id: 9,
          campaign_ids: [1, 2],
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
          client_id: 9,
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
});
