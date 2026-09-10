import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desiredMailboxSignature } from "./mailboxSignature.js";
import {
  INSIGHT_CAMPAIGN_IDS,
  INSIGHT_MAILBOX_SIGNATURE_BLANK,
  insightDualSignatureMismatch,
  insightMailboxSignatureAllowed,
  insightMailboxSecondBrand,
  isInsightCampaign,
  isInsightCampaignId,
  mailboxIsExclusiveInsightStaff,
} from "./insightCampaigns.js";
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";

function account(
  campaignIds: number[],
): SmartleadAccountWithCampaigns {
  return {
    id: 1,
    from_email: "joshua@salesglidertop.org",
    campaign_ids: campaignIds,
  } as SmartleadAccountWithCampaigns;
}

function campaigns(
  rows: Array<{ id: number; name?: string; status?: string }>,
): Map<number, SmartleadCampaign> {
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name ?? `Campaign ${row.id}`,
        status: row.status ?? "ACTIVE",
      } as SmartleadCampaign,
    ]),
  );
}

describe("D184 Insight campaigns are campaign-scoped", () => {
  it("names the seven live Insight campaign ids", () => {
    assert.deepEqual(
      [...INSIGHT_CAMPAIGN_IDS].sort((a, b) => a - b),
      [3921647, 3921650, 3921651, 3921653, 3921654, 3921656, 3921659],
    );
    assert.equal(isInsightCampaignId(3921647), true);
    assert.equal(isInsightCampaignId(88), false);
  });

  it("treats named ids as Insight even without sequences; copy is the other signal", () => {
    assert.equal(isInsightCampaign({ id: 3921651 }), true);
    assert.equal(isInsightCampaign({ id: 88 }), false);
    assert.equal(
      isInsightCampaign(
        { id: 88 },
        [{ seq_number: 1, email_body: "<div>A note from Insight</div>" }],
      ),
      true,
    );
    assert.equal(
      isInsightCampaign(
        { id: 88 },
        [{ seq_number: 1, email_body: "<div>Sean, that offer's still open</div>" }],
      ),
      false,
    );
  });

  it("exclusive Insight staff ignores shells; any other campaign is shared", () => {
    const map = campaigns([
      { id: 3921647, name: "Insight Consolidation Gateway SEG" },
      { id: 3921651, name: "Insight other" },
      { id: 89, name: "SalesGlider Nurture" },
      { id: 501, name: "Canary shell: #3921647 Insight" },
    ]);
    assert.equal(
      mailboxIsExclusiveInsightStaff(account([3921647, 501]), map),
      true,
    );
    assert.equal(
      mailboxIsExclusiveInsightStaff(account([3921647, 3921651]), map),
      true,
    );
    assert.equal(
      mailboxIsExclusiveInsightStaff(account([3921647, 89]), map),
      false,
      "shared with SalesGlider Nurture",
    );
    assert.equal(
      mailboxIsExclusiveInsightStaff(account([89]), map),
      false,
    );
    assert.equal(
      mailboxIsExclusiveInsightStaff(account([3921647, 404]), map),
      false,
      "unknown membership is shared — do not blank",
    );
  });

  it("empty or Josh Osborn / Insight mailbox signatures are allowed on Insight", () => {
    assert.equal(insightMailboxSignatureAllowed(""), true);
    assert.equal(insightMailboxSignatureAllowed("   "), true);
    assert.equal(insightMailboxSignatureAllowed("Josh Osborn\nInsight"), true);
    assert.equal(
      insightMailboxSignatureAllowed("<div>Josh Osborn</div><div>Insight</div>"),
      true,
    );
    assert.equal(
      insightMailboxSignatureAllowed("Joshua Osborn\nSalesGlider"),
      false,
    );
    assert.equal(
      insightMailboxSignatureAllowed("Joshua Osborn\nSalesGlider Growth"),
      false,
    );
  });

  it("flags SalesGlider (or another client) under an Insight close", () => {
    const brands = ["SalesGlider", "Goliath Cybersecurity", "Insight"];
    assert.equal(
      insightMailboxSecondBrand({
        fromName: "Joshua Osborn",
        signature: "Joshua Osborn\nSalesGlider",
        otherClientBrands: brands,
      }),
      "SalesGlider",
    );
    assert.match(
      insightDualSignatureMismatch({
        fromName: "Joshua Osborn",
        signature: "Joshua Osborn\nSalesGlider Growth",
        otherClientBrands: brands,
      }) ?? "",
      /SalesGlider/,
    );
    assert.equal(
      insightDualSignatureMismatch({
        fromName: "Joshua Osborn",
        signature: "",
        otherClientBrands: brands,
      }),
      null,
    );
    assert.equal(INSIGHT_MAILBOX_SIGNATURE_BLANK, "");
  });

  it("does not change desiredMailboxSignature for the SalesGlider client", () => {
    assert.equal(
      desiredMailboxSignature({
        fromName: "Joshua Osborn",
        signature: "",
        clientBrand: "SalesGlider",
      }),
      "Joshua Osborn\nSalesGlider",
    );
    assert.equal(
      desiredMailboxSignature({
        fromName: "Joshua Osborn",
        signature: "Joshua Osborn\nSalesGlider",
        clientBrand: "SalesGlider",
      }),
      "Joshua Osborn\nSalesGlider",
    );
  });
});
