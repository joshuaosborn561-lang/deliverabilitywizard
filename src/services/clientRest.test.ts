import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { isOffWeek, restCohortOf } from "../lib/restCohort.js";
import { StateStore } from "../state/store.js";
import { ClientRestService, shouldVetoRestRestore } from "./clientRest.js";

describe("shouldVetoRestRestore", () => {
  it("allows the first swap when there is no same-ESP score", () => {
    assert.equal(shouldVetoRestRestore(null, 80), false);
    assert.equal(shouldVetoRestRestore(undefined, 80), false);
  });

  it("vetoes a known-bad same-ESP inbox", () => {
    assert.equal(shouldVetoRestRestore(40, 80), true);
    assert.equal(shouldVetoRestRestore(90, 80), false);
  });
});

describe("ClientRestService", () => {
  function emailInCohort(cohort: "A" | "B"): string {
    for (let i = 0; i < 80; i += 1) {
      const email = `box${i}@client.info`;
      if (restCohortOf(email) === cohort) return email;
    }
    throw new Error(`no ${cohort} mailbox in sample`);
  }

  it("removes an off-week client inbox from live campaigns", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // block 0 → B off
    const offEmail = emailInCohort("B");
    assert.equal(isOffWeek(offEmail, now), true);

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
        {
          id: 10,
          from_email: offEmail,
          client_id: 9,
          campaign_ids: [1, 2],
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 11,
          from_email: "spare@client.info",
          client_id: 9,
          campaign_ids: [1, 2],
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
    assert.ok(
      result.benched.some((b) => b.email === offEmail),
      `expected ${offEmail} benched, got ${JSON.stringify(result.benched)}`,
    );
    assert.ok(state.getRestingInbox(offEmail));
    assert.ok(removed.length >= 1);
    assert.ok(removed.every(([, ids]) => ids.includes(10)));
  });

  it("does not restore a rester with a known-bad same-ESP score", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // block 0 → A on
    const onEmail = emailInCohort("A");
    assert.equal(isOffWeek(onEmail, now), false);

    const adds: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-veto-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markRestingInbox({
      accountId: 20,
      email: onEmail,
      clientId: "id:9",
      cohort: restCohortOf(onEmail),
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
    assert.equal(adds.length, 0);
    assert.ok(result.vetoed.some((v) => v.email === onEmail));
    assert.ok(state.getRestingInbox(onEmail), "veto must leave the rest record");
  });

  it("removes an off-week pool generic from live campaigns (D42)", async () => {
    const now = new Date("2026-01-01T17:00:00Z"); // block 0 → B off
    let genericOff = "";
    for (let i = 0; i < 120; i += 1) {
      const email = `generic${i}@pool.info`;
      if (restCohortOf(email) === "B") {
        genericOff = email;
        break;
      }
    }
    assert.ok(genericOff);
    assert.equal(isOffWeek(genericOff, now), true);

    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/client-rest-generic-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: genericOff,
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
        { id: 2, name: "Also", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 55,
          from_email: genericOff,
          client_id: 9,
          from_name: "Pool User",
          campaign_ids: [1, 2],
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 56,
          from_email: "keeper@client.info",
          client_id: 9,
          campaign_ids: [1, 2],
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
    assert.ok(
      result.benched.some((b) => b.email === genericOff),
      `expected ${genericOff} benched, got ${JSON.stringify(result.benched)}`,
    );
    assert.ok(state.getRestingInbox(genericOff));
    assert.ok(removed.every(([, ids]) => ids.includes(55)));
  });
});
