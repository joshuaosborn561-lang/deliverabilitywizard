import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOldClientCampaign } from "./oldClientTeardown.js";

describe("old client teardown (D107)", () => {
  it("matches the three leftover ids and Nieto / MSRS names", () => {
    const ids = [3437329, 3628940, 3628943];
    assert.equal(isOldClientCampaign({ id: 3437329, name: "Anything" }, ids), true);
    assert.equal(
      isOldClientCampaign({ id: 1, name: "Nieto Sports or Airpods" }, ids),
      true,
    );
    assert.equal(
      isOldClientCampaign({ id: 2, name: "MSRS2 Ticket Offer" }, ids),
      true,
    );
    assert.equal(isOldClientCampaign({ id: 3, name: "Positive" }, ids), true);
    assert.equal(
      isOldClientCampaign({ id: 4, name: "Goliath Displacement M" }, ids),
      false,
    );
  });
});
