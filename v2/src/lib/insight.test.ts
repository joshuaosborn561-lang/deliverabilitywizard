import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INSIGHT_CLIENT_ID, SALESGLIDER_CLIENT_ID } from "../canon/constants.js";
import {
  canStaffInsightCampaign,
  insightExemptFromSenderTopUp,
  isInsightJoshAllowedSender,
  isInsightJoshOnlyCampaign,
  isSalesGliderOrInsightSendingDomain,
} from "./insight.js";
import type { SlimCampaign } from "../types.js";

describe("D282 Insight Josh-only senders", () => {
  const insight: SlimCampaign = {
    id: 3921647,
    name: "Insight Consolidation Gateway SEG",
    status: "ACTIVE",
    clientId: INSIGHT_CLIENT_ID,
  };

  it("allows Josh Osborn on salesglider* or insight domains", () => {
    assert.equal(
      isInsightJoshAllowedSender({
        fromName: "Josh Osborn",
        email: "josh@trysalesglider.info",
      }),
      true,
    );
    assert.equal(
      isInsightJoshAllowedSender({
        fromName: "Josh Osborn",
        email: "josh@joshosbornhq.info",
      }),
      true,
    );
    assert.equal(
      isInsightJoshAllowedSender({
        fromName: "Josh Osborn",
        email: "josh@getinsight.co",
      }),
      true,
    );
    assert.equal(isSalesGliderOrInsightSendingDomain("salesglidersdr.info"), true);
    assert.equal(isSalesGliderOrInsightSendingDomain("techevolution.com"), false);
  });

  it("rejects generics, Owen Sanchez, Joshua Osborn, and off-brand domains", () => {
    assert.equal(
      isInsightJoshAllowedSender({
        fromName: "Owen Sanchez",
        email: "owen@joshosbornhq.info",
      }),
      false,
    );
    assert.equal(
      isInsightJoshAllowedSender({
        fromName: "Ada Pool",
        email: "ada@getintroduced.info",
      }),
      false,
    );
    assert.equal(
      isInsightJoshAllowedSender({
        fromName: "Joshua Osborn",
        email: "joshua@salesglidertop.org",
      }),
      false,
    );
    assert.equal(
      isInsightJoshAllowedSender({
        fromName: "Josh Osborn",
        email: "josh@gmail.com",
      }),
      false,
    );
  });

  it("classifies client 582890 and named Insight ids; exempts them from min40", () => {
    assert.equal(isInsightJoshOnlyCampaign(insight), true);
    assert.equal(
      isInsightJoshOnlyCampaign({
        id: 99,
        name: "Random",
        status: "ACTIVE",
        clientId: INSIGHT_CLIENT_ID,
      }),
      true,
    );
    assert.equal(insightExemptFromSenderTopUp(insight), true);
    assert.equal(
      insightExemptFromSenderTopUp({
        id: 89,
        name: "SalesGlider Engagers",
        status: "ACTIVE",
        clientId: SALESGLIDER_CLIENT_ID,
      }),
      false,
    );
  });

  it("canStaffInsightCampaign refuses Owen / generics on Insight", () => {
    assert.equal(
      canStaffInsightCampaign(
        { fromName: "Owen Sanchez", email: "owen@joshosbornhq.info" },
        insight,
      ),
      false,
    );
    assert.equal(
      canStaffInsightCampaign(
        { fromName: "Ada Pool", email: "ada@getintroduced.info" },
        insight,
      ),
      false,
    );
    assert.equal(
      canStaffInsightCampaign(
        { fromName: "Josh Osborn", email: "josh@trysalesglider.info" },
        insight,
      ),
      true,
    );
  });
});
