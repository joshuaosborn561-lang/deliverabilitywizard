import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { CampaignBounceInvestigateService } from "./campaignBounceInvestigate.js";

describe("CampaignBounceInvestigateService", () => {
  it("rotates bad senders on a PAUSED campaign but does not auto-START (D40)", async () => {
    const started: number[] = [];
    const removed: Array<{ campaignId: number; ids: number[] }> = [];
    const state = {
      getPendingResume: () => undefined,
    };
    const smartlead = {
      listCampaigns: async () => [
        { id: 10, name: "Manual pause", status: "PAUSED", client_id: 1 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 1,
          from_email: "a@x.com",
          campaign_ids: [10],
        },
        {
          id: 2,
          from_email: "b@x.com",
          campaign_ids: [10],
        },
      ],
      getMailboxHealthMetrics: async () => [
        { email: "a@x.com", sent: 100, bounced: 20 },
        { email: "b@x.com", sent: 100, bounced: 5 },
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push({ campaignId, ids });
      },
      configureWarmup: async () => undefined,
      getCampaignEmailAccounts: async () => [
        { id: 2, from_email: "b@x.com" },
      ],
      updateCampaignStatus: async (id: number, status: string) => {
        if (status === "START") started.push(id);
      },
    };
    const smartDelivery = {
      listTests: async () => [],
      enrichCampaignIds: async (t: unknown) => t,
      getProviderwiseReport: async () => ({ result: [] }),
    };
    const slack = { send: async () => undefined };

    const service = new CampaignBounceInvestigateService(
      loadConfig({
        CAMPAIGN_BOUNCE_INVESTIGATE_THRESHOLD: "7",
        MIN_BOUNCE_SAMPLE: "50",
        BOUNCE_RATE_THRESHOLD: "5",
        DRY_RUN: "false",
      }),
      smartlead as never,
      smartDelivery as never,
      slack as never,
      state as never,
    );

    const result = await service.run({ dryRun: false });
    assert.equal(result.findings.length, 1);
    assert.ok(result.findings[0]!.rotated.length >= 1);
    assert.equal(result.findings[0]!.resumed, false);
    assert.deepEqual(started, []);
    assert.ok(removed.length >= 1);
  });
});
