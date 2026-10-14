import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BCP_CLIENT_ID,
  EMCOR_CLIENT_ID,
  PARLAY_CLIENT_ID,
  POWERGRYD_CLIENT_ID,
  TECHEVO_CLIENT_ID,
  parseClientIdList,
} from "./namedClientIds.js";

describe("named client ids", () => {
  it("keeps the standing Smartlead ids", () => {
    assert.equal(BCP_CLIENT_ID, 542838);
    assert.equal(TECHEVO_CLIENT_ID, 521881);
    assert.equal(PARLAY_CLIENT_ID, 418274);
    assert.equal(EMCOR_CLIENT_ID, 574020);
    assert.equal(POWERGRYD_CLIENT_ID, 592842);
  });

  it("parses a replacement list from env", () => {
    assert.deepEqual(parseClientIdList("1, 2, x, 0", [9]), [1, 2]);
    assert.deepEqual(parseClientIdList("", [9]), [9]);
    assert.deepEqual(parseClientIdList("none", [9]), []);
  });
});
