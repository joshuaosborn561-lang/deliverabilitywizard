import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AZURE_STAFFABLE_WEIGHT,
  REGULAR_STAFFABLE_WEIGHT,
  mailboxStaffableWeight,
  weightedStaffableShortfall,
} from "./mailboxType.js";
import {
  azureWeightedPodReport,
  weightedStaffableOnCampaign,
} from "./azureStaffWeight.js";
import { pickWeightedGenericReturns } from "./namedWarmSwap.js";
import { emptyGenericSeat } from "./genericPool.js";
import { genericPoolNeedForPod } from "./genericPool.js";
import { detachWouldBreakOnWeekMin } from "./clientStaffFloor.js";

describe("D232 Azure staffable weight", () => {
  it("Azure is 0.1 and every other type is 1", () => {
    assert.equal(AZURE_STAFFABLE_WEIGHT, 0.1);
    assert.equal(REGULAR_STAFFABLE_WEIGHT, 1);
    assert.equal(
      mailboxStaffableWeight({
        from_email: "ada@tidalstackco.com",
        tags: [{ tag_name: "type:azure" }],
      }),
      0.1,
    );
    assert.equal(
      mailboxStaffableWeight({
        from_email: "ben@contoso.com",
        tags: [{ tag_name: "type:m365" }],
      }),
      1,
    );
    assert.equal(
      mailboxStaffableWeight({
        from_email: "cara@gmail.com",
        type: "GMAIL",
      }),
      1,
    );
  });

  it("POD 40 is a weighted sum — 39 regular + 10 Azure is full, 40 Azure is 4", () => {
    assert.equal(weightedStaffableShortfall(39 + 10 * 0.1), 0);
    assert.equal(weightedStaffableShortfall(40 * 0.1), 36);
    assert.equal(genericPoolNeedForPod(39.5), 0.5);
    assert.equal(genericPoolNeedForPod(40), 0);
  });

  it("will not return a weight-1 generic when only 0.1 surplus remains", () => {
    const picked = pickWeightedGenericReturns(
      [
        emptyGenericSeat("old@getintroduced.info", {
          assignedAt: "2026-10-01T00:00:00.000Z",
          staffableWeight: 1,
        }),
        emptyGenericSeat("azure@tidalstackco.com", {
          assignedAt: "2026-10-02T00:00:00.000Z",
          staffableWeight: 0.1,
        }),
      ],
      { namedStaffable: 39.9 },
    );
    assert.deepEqual(
      picked.map((row) => row.email),
      ["azure@tidalstackco.com"],
    );
  });

  it("peel of a regular seat at 40.1 breaks the floor; peel of Azure does not", () => {
    assert.equal(detachWouldBreakOnWeekMin({ status: "ACTIVE" }, 40.1, 1), true);
    assert.equal(detachWouldBreakOnWeekMin({ status: "ACTIVE" }, 40.1, 0.1), false);
    assert.equal(detachWouldBreakOnWeekMin({ status: "ACTIVE" }, 40, 0.1), true);
  });

  it("campaign staffable sum excludes a TERRL-stopped seat", () => {
    const accounts = [
      {
        id: 1,
        from_email: "ada@salesglider.com",
        client_id: 1,
        campaign_ids: [10],
        type: "OUTLOOK",
        is_smtp_success: true,
        is_imap_success: true,
        message_per_day: 15,
      },
      {
        id: 2,
        from_email: "ben@tidalstackco.com",
        client_id: 1,
        campaign_ids: [10],
        type: "OUTLOOK",
        tags: [{ tag_name: "type:azure" }],
        is_smtp_success: true,
        is_imap_success: true,
        message_per_day: 2,
      },
    ];
    assert.equal(
      weightedStaffableOnCampaign({ campaignId: 10, accounts: accounts as never }),
      1.1,
    );
    assert.equal(
      weightedStaffableOnCampaign({
        campaignId: 10,
        accounts: accounts as never,
        excludeAccountIds: [1],
      }),
      0.1,
    );
  });

  it("reports weighted total, shortfall, and non-Azure warm pool cover", () => {
    const rows = azureWeightedPodReport({
      accounts: [
        {
          id: 1,
          from_email: "named@techevolution.com",
          client_id: 77,
          type: "GMAIL",
          tags: [{ tag_name: "POD-A" }],
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 2,
          from_email: "az@tidalstackco.com",
          client_id: 77,
          type: "OUTLOOK",
          tags: [{ tag_name: "POD-A" }, { tag_name: "type:azure" }],
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 3,
          from_email: "free@getintroduced.info",
          client_id: null,
          type: "GMAIL",
          tags: [{ tag_name: "GENERIC" }],
          is_smtp_success: true,
          is_imap_success: true,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ] as never,
      campaigns: [{ id: 10, client_id: 77, status: "ACTIVE" }],
      clients: [{ id: 77, name: "TechEvo" }],
      config: {
        extraGenericMailboxes: [],
        extraGenericDomains: ["getintroduced.info"],
        prewarmedDomains: [],
        campaignMinWarmupDays: 21,
        freshInboxWarmupDays: 21,
      },
      state: {
        isCopyCanary: () => false,
        getPoolMailbox: () => ({
          email: "free@getintroduced.info",
          warmedAt: "2026-01-01T00:00:00.000Z",
        }),
      } as never,
    });
    const a = rows.find((row) => row.pod === "A")!;
    assert.equal(a.weightedTotal, 1.1);
    assert.equal(a.shortfall, 38.9);
    assert.equal(a.nonAzureWarmPoolAvailable, 1);
  });
});
