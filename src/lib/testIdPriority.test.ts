import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_REPORT_TEST_LIMIT,
  prioritizeTestIdsForReports,
} from "./testIdPriority.js";

describe("prioritizeTestIdsForReports", () => {
  it("prefers ACTIVE automated tests over old COMPLETED manuals", () => {
    const selected = prioritizeTestIdsForReports({
      trackedIds: [
        "487556",
        "487555",
        "501702",
        "501703",
        "501714",
        "501701",
      ],
      listedTests: [
        { spam_test_id: 487556, status: "COMPLETED", test_type: "manual" },
        { spam_test_id: 487555, status: "COMPLETED", test_type: "manual" },
        {
          spam_test_id: 501702,
          status: "ACTIVE",
          test_type: "auto",
          every_days: 1,
        },
        {
          spam_test_id: 501703,
          status: "ACTIVE",
          test_type: "auto",
          every_days: 1,
        },
        {
          spam_test_id: 501714,
          status: "ACTIVE",
          test_type: "auto",
          every_days: 1,
        },
        {
          spam_test_id: 501701,
          status: "ACTIVE",
          test_type: "auto",
          every_days: 1,
        },
      ],
      limit: 4,
    });

    assert.deepEqual(selected, ["501714", "501703", "501702", "501701"]);
  });

  it("falls back to newest numeric ids when list status is unknown", () => {
    const selected = prioritizeTestIdsForReports({
      trackedIds: ["100", "501702", "200", "501701"],
      limit: 2,
    });
    assert.deepEqual(selected, ["501702", "501701"]);
  });

  it("defaults to a cap that fits a full recurring fleet", () => {
    assert.ok(DEFAULT_REPORT_TEST_LIMIT >= 100);
    const ids = Array.from({ length: 120 }, (_, i) => String(500000 + i));
    const selected = prioritizeTestIdsForReports({ trackedIds: ids });
    assert.equal(selected.length, DEFAULT_REPORT_TEST_LIMIT);
  });
});
