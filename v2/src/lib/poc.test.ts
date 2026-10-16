import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEEP_ROOTS_NAMED_CLIENT_ID, GOLIATH_CLIENT_ID, POC_FILL_SEATS } from "../canon/constants.js";
import {
  isCallerFollowUpCampaign,
  isGabeFollowUpCampaign,
  isPocEngagementClient,
  seatTargetForCampaign,
  shouldStaffPocCampaign,
} from "./poc.js";

describe("D236 / D254 Deep Roots POC", () => {
  it("Deep Roots 597783 is a 60-seat engagement; Goliath is not", () => {
    assert.equal(
      isPocEngagementClient({ clientId: DEEP_ROOTS_NAMED_CLIENT_ID, name: "Deep Roots Capital" }),
      true,
    );
    assert.equal(
      isPocEngagementClient({ clientId: GOLIATH_CLIENT_ID, name: "Goliath" }),
      false,
    );
    assert.equal(
      seatTargetForCampaign({
        id: 1,
        name: "Deep Roots | Owners",
        status: "ACTIVE",
        clientId: DEEP_ROOTS_NAMED_CLIENT_ID,
      }),
      POC_FILL_SEATS,
    );
  });

  it("staffs DRAFTED POC campaigns and skips Gabe / CALLER FOLLOW-UP", () => {
    assert.equal(
      shouldStaffPocCampaign({
        id: 9,
        name: "Deep Roots | Owners",
        status: "DRAFTED",
        clientId: DEEP_ROOTS_NAMED_CLIENT_ID,
      }),
      true,
    );
    assert.equal(isCallerFollowUpCampaign({ id: 4085160, name: "Gabe Calls | Deep Roots" }), true);
    assert.equal(isGabeFollowUpCampaign({ id: 4074266, name: "Post-call | Gabe | Deep Roots" }), true);
    assert.equal(
      shouldStaffPocCampaign({
        id: 4085160,
        name: "Gabe Calls | Deep Roots",
        status: "ACTIVE",
        clientId: DEEP_ROOTS_NAMED_CLIENT_ID,
      }),
      false,
    );
  });
});
