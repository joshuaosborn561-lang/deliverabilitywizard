import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { assignClientCohorts, isOffWeek } from "../lib/restCohort.js";
import { StateStore } from "../state/store.js";
import { ClientRestService, shouldVetoRestRestore } from "./clientRest.js";

describe("shouldVetoRestRestore", () => {
  it("allows the first swap when there is no same-ESP score", () => {
    assert.equal(shouldVetoRestRestore(null, 80), false);
    assert.equal(shouldVetoRestRestore(undefined, 80), false);
  });

  it("never vetoes on an old same-ESP reading (D59)", () => {
    assert.equal(shouldVetoRestRestore(40, 80), false);
    assert.equal(shouldVetoRestRestore(90, 80), false);
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
        },
        {
          id: 21,
          from_email: "z@client.info",
          client_id: 9,
          campaign_ids: [1],
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
    assert.equal(result.vetoed.length, 0);
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
        },
        {
          id: 56,
          from_email: "keeper@client.info",
          client_id: 9,
          campaign_ids: [1],
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
        },
        {
          id: 21,
          from_email: "z@client.info",
          client_id: 9,
          campaign_ids: [1, 2],
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
});
