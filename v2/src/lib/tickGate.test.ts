import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSkipLog, tickSkipReason } from "./tickGate.js";

describe("D280 tick skip reasons", () => {
  it("names in_flight, quiet hours, and missing keys; in_flight wins", () => {
    assert.equal(tickSkipReason({ inFlight: true, quietHours: true }), "in_flight");
    assert.equal(tickSkipReason({ quietHours: true }), "quiet_hours");
    assert.equal(tickSkipReason({ missingKey: "smartdelivery" }), "missing_smartdelivery_key");
    assert.equal(tickSkipReason({ missingKey: "smartlead" }), "missing_smartlead_key");
    assert.equal(tickSkipReason({ missingKey: "inboxkit" }), "missing_inboxkit_key");
    assert.equal(tickSkipReason({}), null);
    assert.equal(
      formatSkipLog("staff", "quiet_hours"),
      "[v2] staff skip reason=quiet_hours",
    );
  });
});
