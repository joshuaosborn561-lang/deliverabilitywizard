import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { OneClientMembershipService } from "./oneClientMembership.js";

describe("OneClientMembershipService", () => {
  it("pulls a Goliath inbox off a Peterson campaign and rewrites the sig (D75)", async () => {
    const removed: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const state = new StateStore(
      `/tmp/one-client-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const service = new OneClientMembershipService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Goliath Displacement M", status: "ACTIVE", client_id: 548611 },
          { id: 2, name: "Peterson C3", status: "ACTIVE", client_id: 99 },
          { id: 9, name: "Pod control shell", status: "PAUSED", client_id: 548611 },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "aarav@pool.info",
            from_name: "Aarav Sanchez",
            signature: "Aarav Sanchez\nRoofs by Peterson",
            client_id: 548611,
            campaign_ids: [1, 2, 9],
          },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
          { id: 99, name: "Peterson", logo: "Roofs by Peterson" },
        ],
        removeEmailAccountsFromCampaign: async (campaignId: number, ids: number[]) => {
          removed.push([campaignId, [...ids]]);
        },
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          updates.push({ id, fields });
        },
      } as unknown as SmartleadClient,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(removed, [[2, [11]]]);
    assert.equal(result.pulled[0]?.email, "aarav@pool.info");
    assert.equal(result.signaturesSet, 1);
    assert.equal(updates[0]?.fields.signature, "Aarav Sanchez\nGoliath Cybersecurity");
  });
});
