import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  needsMinTimeGap,
  readMinTimeGapMins,
} from "./mailboxSendSettings.js";

describe("mailboxSendSettings", () => {
  it("treats missing / null / 0 gap as needing the 10-minute floor", () => {
    assert.equal(Number.isNaN(readMinTimeGapMins({})), true);
    assert.equal(
      Number.isNaN(readMinTimeGapMins({ minTimeToWaitInMins: null })),
      true,
    );
    assert.equal(needsMinTimeGap({ minTimeToWaitInMins: null }, 10), true);
    assert.equal(needsMinTimeGap({ minTimeToWaitInMins: 0 }, 10), true);
    assert.equal(needsMinTimeGap({ minTimeToWaitInMins: 5 }, 10), true);
    assert.equal(needsMinTimeGap({ minTimeToWaitInMins: 10 }, 10), false);
    assert.equal(
      needsMinTimeGap({ time_to_wait_in_mins: "10" } as never, 10),
      false,
    );
  });
});
