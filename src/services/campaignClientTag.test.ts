import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { CampaignClientTagService } from "./campaignClientTag.js";

describe("CampaignClientTagService", () => {
  it("assigns a missing Goliath client tag from the campaign name (D77)", async () => {
    const writes: Array<[number, number]> = [];
    const service = new CampaignClientTagService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Goliath Displacement M", status: "PAUSED" },
          { id: 2, name: "Goliath Displacement L", status: "ACTIVE", client_id: 548611 },
          { id: 9, name: "Pod control shell", status: "PAUSED" },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
          { id: 99, name: "Peterson", logo: "Roofs by Peterson" },
        ],
        setCampaignClientId: async (campaignId: number, clientId: number) => {
          writes.push([campaignId, clientId]);
        },
        ensureClient: async () => {
          throw new Error("ensureClient should not run when a name match exists");
        },
      } as unknown as SmartleadClient,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(writes, [[1, 548611]]);
    assert.equal(result.assigned[0]?.clientId, 548611);
    assert.ok(result.skipped.some((row) => row.includes("shell")));
  });

  it("ensures a missing Nieto client row then tags every Nieto campaign (D144)", async () => {
    const writes: Array<[number, number]> = [];
    let ensures = 0;
    const service = new CampaignClientTagService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 3437329, name: "Nieto Sports or Airpods Offer/Proprietary Tech", status: "PAUSED" },
          { id: 3867914, name: "Nieto RB2B", status: "PAUSED" },
          { id: 3628940, name: "MSRS2 Ticket Offer Property Manager", status: "PAUSED" },
          { id: 99, name: "Mystery untitled", status: "ACTIVE" },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        ],
        setCampaignClientId: async (campaignId: number, clientId: number) => {
          writes.push([campaignId, clientId]);
        },
        ensureClient: async (name: string) => {
          ensures += 1;
          if (name === "Nieto") return 701;
          if (name === "MSRS") return 702;
          throw new Error(`unexpected ensure ${name}`);
        },
      } as unknown as SmartleadClient,
    );

    const result = await service.run({ dryRun: false });
    assert.equal(ensures, 2);
    assert.deepEqual(writes, [
      [3437329, 701],
      [3867914, 701],
      [3628940, 702],
    ]);
    assert.ok(result.skipped.some((row) => row.includes("Mystery untitled")));
  });
});
