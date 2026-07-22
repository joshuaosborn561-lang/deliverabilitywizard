import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeHoldUntilDate,
  daysSince,
  isActiveCampaignStatus,
  warmupStartedAt,
} from "../services/warmupGate.js";

describe("warmupGate helpers", () => {
  it("detects ACTIVE campaign statuses", () => {
    assert.equal(isActiveCampaignStatus("ACTIVE"), true);
    assert.equal(isActiveCampaignStatus("START"), true);
    assert.equal(isActiveCampaignStatus("PAUSED"), false);
  });

  it("treats future HOLD-UNTIL as active", () => {
    const hold = activeHoldUntilDate(
      ["HOLD-UNTIL-2099-01-15"],
      new Date("2026-07-22T12:00:00Z"),
    );
    assert.equal(hold, "2099-01-15");
  });

  it("ignores expired HOLD-UNTIL", () => {
    const hold = activeHoldUntilDate(
      ["HOLD-UNTIL-2020-01-01"],
      new Date("2026-07-22T12:00:00Z"),
    );
    assert.equal(hold, null);
  });

  it("prefers warmup_details created_at", () => {
    const started = warmupStartedAt({
      id: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      warmup_details: { created_at: "2026-06-01T00:00:00.000Z" },
    });
    assert.equal(started, "2026-06-01T00:00:00.000Z");
  });

  it("computes days since", () => {
    const days = daysSince(
      "2026-07-08T12:00:00.000Z",
      Date.parse("2026-07-22T12:00:00.000Z"),
    );
    assert.equal(days, 14);
  });
});
