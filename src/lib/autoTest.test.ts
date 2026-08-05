import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TEST_LIST_LIMIT,
  isAutomatedTest,
  isTestStoppable,
  normalizeTestList,
} from "../clients/smartdelivery.js";
import { addDaysIso } from "../services/campaignScanner.js";

describe("isAutomatedTest", () => {
  it("detects recurrence via every_days", () => {
    assert.equal(isAutomatedTest({ every_days: 7 }), true);
    assert.equal(isAutomatedTest({ every_days: 0 }), false);
  });

  it("detects recurrence via schedule_start_time", () => {
    assert.equal(
      isAutomatedTest({ schedule_start_time: "2026-07-30T00:00:00Z" }),
      true,
    );
  });

  it("falls back to test_type naming", () => {
    assert.equal(isAutomatedTest({ test_type: "AUTOMATED" }), true);
    assert.equal(isAutomatedTest({ test_type: "scheduled" }), true);
    assert.equal(isAutomatedTest({ test_type: "manual" }), false);
  });

  it("treats a bare manual test as not automated", () => {
    assert.equal(isAutomatedTest({ test_name: "one off" }), false);
  });
});

describe("isTestStoppable", () => {
  it("treats unknown/missing status as stoppable (fail safe)", () => {
    assert.equal(isTestStoppable({}), true);
    assert.equal(isTestStoppable({ status: "running" }), true);
    assert.equal(isTestStoppable({ status: "active" }), true);
  });

  it("skips tests that already ended", () => {
    assert.equal(isTestStoppable({ status: "STOPPED" }), false);
    assert.equal(isTestStoppable({ status: "completed" }), false);
    assert.equal(isTestStoppable({ status: "cancelled" }), false);
    assert.equal(isTestStoppable({ status: "expired" }), false);
  });
});

describe("addDaysIso", () => {
  it("adds days and returns ISO 8601", () => {
    const out = addDaysIso(new Date("2026-07-30T12:00:00.000Z"), 30);
    assert.equal(out, "2026-08-29T12:00:00.000Z");
  });

  it("does not mutate the input date", () => {
    const base = new Date("2026-07-30T12:00:00.000Z");
    addDaysIso(base, 5);
    assert.equal(base.toISOString(), "2026-07-30T12:00:00.000Z");
  });
});

describe("DEFAULT_TEST_LIST_LIMIT", () => {
  it("pages larger than SmartDelivery's implicit ~10-row default", () => {
    assert.ok(DEFAULT_TEST_LIST_LIMIT >= 50);
  });
});

describe("normalizeTestList", () => {
  it("accepts a bare array", () => {
    assert.equal(normalizeTestList([{ spam_test_id: 1 }]).length, 1);
  });
});
