import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { totalDailySendCeiling } from "./sendCeiling.js";

describe("totalDailySendCeiling", () => {
  it("adds campaign cap and warmup so 30 campaign excludes warmup", () => {
    assert.equal(
      totalDailySendCeiling({ messagePerDay: 30, warmupTotalPerDay: 20 }),
      50,
    );
  });
});
