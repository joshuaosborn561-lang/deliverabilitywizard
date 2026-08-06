import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { totalDailySendCeiling } from "./sendCeiling.js";

describe("totalDailySendCeiling", () => {
  it("is the campaign Message Per Day field (warmups not included)", () => {
    assert.equal(
      totalDailySendCeiling({ messagePerDay: 30, warmupTotalPerDay: 20 }),
      30,
    );
  });
});
