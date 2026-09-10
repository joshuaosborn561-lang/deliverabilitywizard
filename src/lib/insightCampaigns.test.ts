import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desiredMailboxSignature } from "./mailboxSignature.js";
import {
  INSIGHT_CAMPAIGN_IDS,
  INSIGHT_CLIENT_ID,
  INSIGHT_MAILBOX_SIGNATURE_BLANK,
  insightDualSignatureMismatch,
  insightMailboxSignatureAllowed,
  insightMailboxSecondBrand,
  canAttachMailboxToCampaign,
  isInsightCampaign,
  isInsightCampaignId,
  isInsightClientId,
  isInsightRestStickyCampaign,
  mailboxIsExclusiveInsightStaff,
  mailboxStaffsActiveSalesGlider,
  SALESGLIDER_CLIENT_ID,
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

  it("D192: Insight is client 582890; SalesGlider stays 345263", () => {
    assert.equal(INSIGHT_CLIENT_ID, 582890);
    assert.equal(SALESGLIDER_CLIENT_ID, 345263);
    assert.equal(isInsightClientId(582890), true);
    assert.equal(isInsightClientId(345263), false);
    assert.notEqual(INSIGHT_CLIENT_ID, SALESGLIDER_CLIENT_ID);
  });

  it("D189: named ids and Insight-prefix + 345263 are rest-sticky; other clients are not", () => {
    assert.equal(
      isInsightRestStickyCampaign({
        id: 3921647,
        name: "Insight Consolidation Gateway SEG",
        client_id: 345263,
      }),
      true,
    );
    assert.equal(
      isInsightRestStickyCampaign({
        id: 4000001,
        name: "Insight Extra Lane",
        client_id: 345263,
      }),
      true,
      "future Insight-named lane on SalesGlider",
    );
    assert.equal(
      isInsightRestStickyCampaign({
        id: 89,
        name: "SalesGlider Engagers",
        client_id: 345263,
      }),
      false,
    );
    assert.equal(
      isInsightRestStickyCampaign({
        id: 4000002,
        name: "Insight Extra Lane",
        client_id: 582890,
      }),
      true,
      "Insight-named lane on client 582890 is rest-sticky (D192)",
    );
    assert.equal(
      isInsightRestStickyCampaign({
        id: 90,
        name: "Insight Other Client",
        client_id: 9,
      }),
      false,
      "Insight name on another client is not the D184 pool",
    );
    assert.equal(
      isInsightRestStickyCampaign({
        id: 91,
        name: "Insightful Staffing",
        client_id: 345263,
      }),
      false,
      "prefix requires 'Insight ' with a space",
    );
    assert.equal(isInsightRestStickyCampaign(undefined), false);
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

  it("exclusive Insight staff is not-on-ACTIVE-SG; shells and paused SG do not share", () => {
    const map = new Map<number, SmartleadCampaign>([
      [
        3921647,
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 345263,
        } as SmartleadCampaign,
      ],
      [
        3921651,
        {
          id: 3921651,
          name: "Insight other",
          status: "ACTIVE",
          client_id: 345263,
        } as SmartleadCampaign,
      ],
      [
        89,
        {
          id: 89,
          name: "SalesGlider Nurture",
          status: "ACTIVE",
          client_id: 345263,
        } as SmartleadCampaign,
      ],
      [
        90,
        {
          id: 90,
          name: "SalesGlider Engagers",
          status: "PAUSED",
          client_id: 345263,
        } as SmartleadCampaign,
      ],
      [
        501,
        {
          id: 501,
          name: "Canary shell: #3921647 Insight",
          status: "PAUSED",
        } as SmartleadCampaign,
      ],
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
      mailboxIsExclusiveInsightStaff(account([3921647, 90]), map),
      true,
      "PAUSED SalesGlider does not make the seat shared",
    );
    assert.equal(
      mailboxIsExclusiveInsightStaff(account([3921647, 89]), map),
      false,
      "ACTIVE SalesGlider Engagers is shared",
    );
    assert.equal(
      mailboxStaffsActiveSalesGlider(account([3921647, 89]), map),
      true,
    );
    assert.equal(mailboxIsExclusiveInsightStaff(account([89]), map), false);
    assert.equal(
      mailboxIsExclusiveInsightStaff(account([3921647, 404]), map),
      false,
      "unknown membership is shared — do not blank",
    );
  });

  it("does not attach ACTIVE SG staff onto Insight, or Insight staff onto ACTIVE SG", () => {
    const map = new Map<number, SmartleadCampaign>([
      [
        3921647,
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 345263,
        } as SmartleadCampaign,
      ],
      [
        89,
        {
          id: 89,
          name: "SalesGlider Nurture",
          status: "ACTIVE",
          client_id: 345263,
        } as SmartleadCampaign,
      ],
    ]);
    const insightSeat = account([3921647]);
    const sgSeat = account([89]);
    const unattached = account([]);
    assert.equal(
      canAttachMailboxToCampaign(insightSeat, map.get(3921651) ?? {
        id: 3921651,
        name: "Insight other",
        status: "ACTIVE",
        client_id: 345263,
      } as SmartleadCampaign, map),
      true,
    );
    assert.equal(
      canAttachMailboxToCampaign(sgSeat, map.get(3921647)!, map),
      false,
    );
    assert.equal(
      canAttachMailboxToCampaign(insightSeat, map.get(89)!, map),
      false,
    );
    assert.equal(
      canAttachMailboxToCampaign(unattached, map.get(3921647)!, map, {
        insightRequiresExisting: true,
      }),
      false,
      "Insight is not default client-345263 fan-out",
    );
    assert.equal(
      canAttachMailboxToCampaign(unattached, map.get(3921647)!, map),
      true,
      "top-up may add an exclusive seat that is not on ACTIVE SG",
    );
    assert.equal(
      canAttachMailboxToCampaign(unattached, map.get(89)!, map),
      true,
    );
    assert.equal(
      canAttachMailboxToCampaign(sgSeat, map.get(89)!, map),
      true,
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
