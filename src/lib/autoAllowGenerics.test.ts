import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BCP_CLIENT_ID,
  DEFAULT_AUTO_ALLOW_GENERIC_CLIENT_IDS,
  EMCOR_CLIENT_ID,
  PARLAY_CLIENT_ID,
  TECHEVO_CLIENT_ID,
  clientAutoAllowsGenerics,
  parseClientIdList,
} from "./autoAllowGenerics.js";
import { INSIGHT_CLIENT_ID } from "./insightCampaigns.js";

describe("auto-allow generics (D205)", () => {
  it("seeds BCP, TechEvo, Parlay, Insight, EMCOR", () => {
    assert.deepEqual(
      [...DEFAULT_AUTO_ALLOW_GENERIC_CLIENT_IDS].sort((a, b) => a - b),
      [TECHEVO_CLIENT_ID, PARLAY_CLIENT_ID, BCP_CLIENT_ID, EMCOR_CLIENT_ID, INSIGHT_CLIENT_ID].sort(
        (a, b) => a - b,
      ),
    );
    assert.equal(
      clientAutoAllowsGenerics(BCP_CLIENT_ID, DEFAULT_AUTO_ALLOW_GENERIC_CLIENT_IDS),
      true,
    );
    assert.equal(
      clientAutoAllowsGenerics(548611, DEFAULT_AUTO_ALLOW_GENERIC_CLIENT_IDS),
      false,
    );
  });

  it("parses a replacement list from env", () => {
    assert.deepEqual(parseClientIdList("1, 2, x, 0", [9]), [1, 2]);
    assert.deepEqual(parseClientIdList("", [9]), [9]);
  });
});
