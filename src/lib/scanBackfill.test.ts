import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCAN_BACKFILL_MIN_REMAINING_MS,
  scanBackfillBudgetSkipReason,
  shouldSkipScanBackfillForLockBudget,
} from "./scanBackfill.js";

describe("D297 scan-backfill lock budget", () => {
  it("skips when less than 20 minutes remain in the 45-minute lock", () => {
    assert.equal(SCAN_BACKFILL_MIN_REMAINING_MS, 20 * 60 * 1000);
    assert.equal(shouldSkipScanBackfillForLockBudget(19 * 60 * 1000), true);
    assert.equal(shouldSkipScanBackfillForLockBudget(20 * 60 * 1000), false);
    assert.equal(shouldSkipScanBackfillForLockBudget(45 * 60 * 1000), false);
    assert.equal(shouldSkipScanBackfillForLockBudget(0), true);
    assert.equal(
      scanBackfillBudgetSkipReason(12 * 60 * 1000),
      "skip — 12m remain in 45m health lock",
    );
  });
});
