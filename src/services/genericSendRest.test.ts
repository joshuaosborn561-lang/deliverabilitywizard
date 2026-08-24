import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import {
  GenericSendRestService,
  genericSendTenureDays,
} from "./genericSendRest.js";

describe("genericSendTenureDays", () => {
  it("counts whole days from the send start", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    assert.equal(genericSendTenureDays("2026-01-18T00:00:00Z", now), 14);
    assert.equal(genericSendTenureDays(undefined, now), null);
  });
});

describe("GenericSendRestService", () => {
  it("starts a clock on first sight and benches after 14 days", async () => {
    const state = new StateStore(
      `/tmp/generic-rest-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "warm@pool.info",
      domain: "pool.info",
      firstName: "Warm",
      lastName: "Pool",
      platform: "GOOGLE",
      status: "assigned",
      smartleadAccountId: 7,
    });

    const removed: number[] = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "Spare", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 7,
          from_email: "warm@pool.info",
          client_id: 9,
          campaign_ids: [1],
        },
        {
          id: 8,
          from_email: "keeper@client.info",
          client_id: 9,
          campaign_ids: [1],
        },
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push(campaignId);
        void ids;
      },
      updateEmailAccount: async () => undefined,
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new GenericSendRestService(
      loadConfig({ ENABLE_GENERIC_SEND_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const first = await service.run({
      dryRun: false,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    assert.equal(first.clocksStarted, 1);
    assert.equal(first.benched.length, 0);
    assert.ok(state.getGenericSendStartedAt("warm@pool.info"));

    const later = await service.run({
      dryRun: false,
      now: new Date("2026-01-16T00:00:00Z"),
    });
    assert.ok(later.benched.some((row) => row.email === "warm@pool.info"));
    assert.equal(state.getRestingInbox("warm@pool.info")?.kind, "generic");
    assert.ok(removed.includes(1));
  });
});
