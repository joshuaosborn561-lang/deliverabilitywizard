import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hashEmail,
  isOffWeek,
  isoWeekNumberNy,
  onWeekCohort,
  restCohortOf,
  restFortnightBlock,
} from "./restCohort.js";

describe("restCohort", () => {
  it("assigns a stable A/B cohort from the email", () => {
    const a = restCohortOf("alex@client.info");
    const b = restCohortOf("alex@client.info");
    assert.equal(a, b);
    assert.ok(a === "A" || a === "B");
    assert.equal(hashEmail("Alex@Client.INFO"), hashEmail("alex@client.info"));
  });

  it("splits a pair of addresses across cohorts", () => {
    const seen = new Set<string>();
    for (const email of [
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
      "e@x.com",
      "f@x.com",
    ]) {
      seen.add(restCohortOf(email));
    }
    assert.equal(seen.size, 2, "both cohorts should appear in a small sample");
  });

  it("uses NY ISO weeks for the fortnight block", () => {
    // 2026-01-01 is a Thursday in NY — ISO week 1, block 0.
    const week1 = new Date("2026-01-01T17:00:00Z");
    assert.equal(isoWeekNumberNy(week1), 1);
    assert.equal(restFortnightBlock(week1), 0);
    assert.equal(onWeekCohort(week1), "A");
    assert.equal(isOffWeek("needs-B-check@x.com", week1), restCohortOf("needs-B-check@x.com") === "B");

    // ISO week 2 is still block 0; week 3 flips to block 1.
    const week3 = new Date("2026-01-15T17:00:00Z");
    assert.equal(isoWeekNumberNy(week3), 3);
    assert.equal(restFortnightBlock(week3), 1);
    assert.equal(onWeekCohort(week3), "B");
  });
});
