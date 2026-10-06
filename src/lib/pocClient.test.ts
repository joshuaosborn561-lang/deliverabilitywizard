import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEEP_ROOTS_CLIENT_ID,
  DEFAULT_POC_CLIENT_NAME_PATTERNS,
  GABE_FOLLOW_UP_CAMPAIGN_IDS,
  GABE_POST_CALL_CAMPAIGN_ID,
  GOLIATH_CLIENT_ID,
  isGabeFollowUpCampaign,
  isGabePostCallCampaign,
  isPocClient,
  isPocEngagementClient,
  isPocLivingCampaignStatus,
  pocEngagementClientIds,
  pocEngagementSeatTarget,
  pocSignature,
  shouldStaffPocCampaign,
} from "./pocClient.js";

describe("pocClient (D81/D236)", () => {
  it("defaults include Goliath and Deep Roots on one name list", () => {
    assert.deepEqual([...DEFAULT_POC_CLIENT_NAME_PATTERNS], [
      "goliath",
      "deep roots",
    ]);
    assert.equal(isPocClient("Deep Roots Capital"), true);
    assert.equal(isPocClient("Goliath Displacement"), true);
    assert.equal(isPocClient("Bolder Cyber Partners"), false);
  });

  it("engagement is the name list minus Goliath and ended ids", () => {
    assert.equal(
      isPocEngagementClient({
        clientId: DEEP_ROOTS_CLIENT_ID,
        hay: "Deep Roots Capital",
      }),
      true,
    );
    assert.equal(
      isPocEngagementClient({
        clientId: GOLIATH_CLIENT_ID,
        hay: "Goliath Cybersecurity",
      }),
      false,
    );
    assert.equal(
      isPocEngagementClient({
        clientId: DEEP_ROOTS_CLIENT_ID,
        hay: "Deep Roots Capital",
        endedIds: [DEEP_ROOTS_CLIENT_ID],
      }),
      false,
    );
    assert.deepEqual(
      pocEngagementClientIds([
        { id: GOLIATH_CLIENT_ID, logo: "Goliath Cybersecurity" },
        { id: DEEP_ROOTS_CLIENT_ID, logo: "Deep Roots Capital" },
        { id: 542838, logo: "Bolder Cyber Partners" },
      ]),
      [DEEP_ROOTS_CLIENT_ID],
    );
  });

  it("living POC campaigns include DRAFTED and never staff Gabe's post-call shell", () => {
    assert.equal(isPocLivingCampaignStatus("DRAFTED"), true);
    assert.equal(isPocLivingCampaignStatus("DRAFT"), true);
    assert.equal(isPocLivingCampaignStatus("ACTIVE"), true);
    assert.equal(isPocLivingCampaignStatus("PAUSED"), false);
    assert.equal(isGabePostCallCampaign(GABE_POST_CALL_CAMPAIGN_ID), true);
    assert.equal(
      shouldStaffPocCampaign({ id: 4084613, status: "DRAFTED" }),
      true,
    );
    assert.equal(
      shouldStaffPocCampaign({
        id: GABE_POST_CALL_CAMPAIGN_ID,
        status: "DRAFTED",
      }),
      false,
    );
    assert.equal(pocEngagementSeatTarget(), 60);
  });

  it("D241: never staff a Gabe-named campaign or a reserved-linked campaign", () => {
    assert.equal(isGabeFollowUpCampaign({ id: 4085160, name: "Gabe Calls | Deep Roots" }), true);
    assert.equal(isGabeFollowUpCampaign({ id: 99, name: "Post-call | Gabe | SalesGlider" }), true);
    assert.equal(
      (GABE_FOLLOW_UP_CAMPAIGN_IDS as readonly number[]).includes(4085160),
      true,
    );
    assert.equal(
      shouldStaffPocCampaign({
        id: 4085160,
        name: "Gabe Calls | Deep Roots",
        status: "DRAFTED",
      }),
      false,
    );
    assert.equal(
      shouldStaffPocCampaign(
        { id: 4090001, name: "Deep Roots Voicemail", status: "DRAFTED" },
        { reservedCampaignIds: [4090001] },
      ),
      false,
    );
    assert.equal(
      shouldStaffPocCampaign({
        id: 4084613,
        name: "Deep Roots A",
        status: "DRAFTED",
      }),
      true,
    );
  });

  it("POC signature is from_name plus the full client brand", () => {
    assert.equal(
      pocSignature("Ada Lovelace", "Deep Roots Capital"),
      "Ada Lovelace\nDeep Roots Capital",
    );
  });
});
