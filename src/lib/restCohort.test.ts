import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cohortForEmail,
  restingCohortForDate,
  isoWeekNumberNy,
} from "./restCohort.js";

describe("restCohort", () => {
  it("assigns a stable A/B/C cohort per email", () => {
    assert.equal(cohortForEmail("a@client.com"), cohortForEmail("A@Client.com"));
    const letters = new Set(
      ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"].map(
        cohortForEmail,
      ),
    );
    assert.ok(letters.size >= 2, "hash should spread across cohorts");
  });

  it("picks one resting cohort from the NY week number", () => {
    const week = isoWeekNumberNy(new Date("2026-08-17T15:00:00Z"));
    assert.ok(week >= 1 && week <= 53);
    const resting = restingCohortForDate(new Date("2026-08-17T15:00:00Z"));
    assert.ok(resting === "A" || resting === "B" || resting === "C");
  });
});
