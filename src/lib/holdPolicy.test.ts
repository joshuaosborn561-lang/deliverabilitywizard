import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INSIGHT_SEG_CAMPAIGN_ID } from "./deliverabilitySlack.js";
import {
  DEFAULT_HOLD_CAMPAIGN_IDS,
  DEFAULT_HOLD_CLIENT_ZERO_ACTIVE,
  campaignHoldReason,
  campaignMatchesHoldName,
  parseClientUntilList,
  parseIdList,
  ymdStillHeld,
} from "./holdPolicy.js";

const policy = {
  campaignIds: DEFAULT_HOLD_CAMPAIGN_IDS,
  namePatterns: ["Insight SEG", "Staffing Owners CANDIDATES"],
  clientZeroActive: DEFAULT_HOLD_CLIENT_ZERO_ACTIVE,
};

describe("hold policy (D205)", () => {
  it("holds the seeded Parlay SEG / Thesis / Cold Call / Insight SEG ids", () => {
    assert.ok(DEFAULT_HOLD_CAMPAIGN_IDS.includes(3847837));
    assert.ok(DEFAULT_HOLD_CAMPAIGN_IDS.includes(3969268));
    assert.ok(DEFAULT_HOLD_CAMPAIGN_IDS.includes(3739316));
    assert.ok(DEFAULT_HOLD_CAMPAIGN_IDS.includes(INSIGHT_SEG_CAMPAIGN_ID));
    assert.match(
      campaignHoldReason({ id: 3847837, name: "Parlay SEG" }, policy, "2026-09-29") ?? "",
      /standing campaign hold/,
    );
  });

  it("resolves Insight SEG and SG Staffing Owners CANDIDATES by name", () => {
    assert.equal(campaignMatchesHoldName("Insight SEG Owners", policy.namePatterns), true);
    assert.equal(
      campaignMatchesHoldName(
        "SG Staffing Owners CANDIDATES — wave 2",
        policy.namePatterns,
      ),
      true,
    );
    assert.equal(campaignMatchesHoldName("Insight Engagers", policy.namePatterns), false);
  });

  it("holds Goliath through 2026-10-15 and not the day after", () => {
    const goliath = { id: 9, name: "Goliath Displacement", client_id: 548611 };
    assert.match(
      campaignHoldReason(goliath, policy, "2026-10-15") ?? "",
      /0 ACTIVE until 2026-10-15/,
    );
    assert.equal(campaignHoldReason(goliath, policy, "2026-10-16"), undefined);
    assert.equal(ymdStillHeld("2026-10-15", "2026-10-15"), true);
    assert.equal(ymdStillHeld("2026-10-15", "2026-10-16"), false);
  });

  it("does not hold shells", () => {
    assert.equal(
      campaignHoldReason(
        { id: 3847837, name: "Canary shell: #1" },
        policy,
        "2026-09-29",
      ),
      undefined,
    );
  });

  it("parses empty env as the seeded defaults", () => {
    assert.deepEqual(parseIdList(undefined, [1, 2]), [1, 2]);
    assert.deepEqual(parseIdList("", [1, 2]), [1, 2]);
    assert.deepEqual(parseIdList("none", [1, 2]), []);
    assert.deepEqual(
      parseClientUntilList(undefined, DEFAULT_HOLD_CLIENT_ZERO_ACTIVE),
      [...DEFAULT_HOLD_CLIENT_ZERO_ACTIVE],
    );
    assert.deepEqual(parseClientUntilList("none", DEFAULT_HOLD_CLIENT_ZERO_ACTIVE), []);
  });
});
