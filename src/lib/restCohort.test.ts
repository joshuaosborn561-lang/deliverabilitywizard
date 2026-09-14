import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assignClientCohorts,
  isOffWeek,
  isoWeekNumberNy,
  onWeekCohort,
  restFortnightBlock,
  restRolloverSnapshot,
} from "./restCohort.js";

describe("restCohort", () => {
  it("splits one client's inboxes evenly and stably (D43)", () => {
    const emails = [
      "z@client.info",
      "a@client.info",
      "m@client.info",
      "b@client.info",
    ];
    const first = assignClientCohorts(emails);
    const second = assignClientCohorts([...emails].reverse());
    assert.equal(first.get("a@client.info"), "A");
    assert.equal(first.get("b@client.info"), "A");
    assert.equal(first.get("m@client.info"), "B");
    assert.equal(first.get("z@client.info"), "B");
    assert.equal(first.get("a@client.info"), second.get("a@client.info"));
    assert.equal(first.get("z@client.info"), second.get("z@client.info"));
  });

  it("D192: splits ~50/50 within Outlook and within Gmail, not one alphabetical half", () => {
    const inboxes = [
      { email: "a-gmail@client.info", type: "GMAIL" },
      { email: "b-gmail@client.info", type: "GMAIL" },
      { email: "c-gmail@client.info", type: "GOOGLE" },
      { email: "d-gmail@client.info", type: "GMAIL" },
      { email: "a-outlook@client.info", type: "OUTLOOK" },
      { email: "b-outlook@client.info", type: "OUTLOOK" },
      { email: "c-outlook@client.info", type: "MICROSOFT" },
      { email: "d-outlook@client.info", type: "OUTLOOK" },
    ];
    const cohorts = assignClientCohorts(inboxes);
    const gmailA = ["a-gmail@client.info", "b-gmail@client.info", "c-gmail@client.info", "d-gmail@client.info"]
      .filter((email) => cohorts.get(email) === "A").length;
    const outlookA = ["a-outlook@client.info", "b-outlook@client.info", "c-outlook@client.info", "d-outlook@client.info"]
      .filter((email) => cohorts.get(email) === "A").length;
    assert.equal(gmailA, 2, "Gmail half on A");
    assert.equal(outlookA, 2, "Outlook half on A");
    const reversed = assignClientCohorts([...inboxes].reverse());
    assert.equal(reversed.get("a-gmail@client.info"), cohorts.get("a-gmail@client.info"));
    assert.equal(reversed.get("d-outlook@client.info"), cohorts.get("d-outlook@client.info"));
  });

  it("D192: alphabetical-only would put every Gmail on A and every Outlook on B — ESP split does not", () => {
    const inboxes = [
      { email: "aaa@client.info", type: "GMAIL" },
      { email: "aab@client.info", type: "GMAIL" },
      { email: "zzz@client.info", type: "OUTLOOK" },
      { email: "zzy@client.info", type: "OUTLOOK" },
    ];
    const cohorts = assignClientCohorts(inboxes);
    assert.equal(cohorts.get("aaa@client.info"), "A");
    assert.equal(cohorts.get("aab@client.info"), "B");
    assert.equal(cohorts.get("zzy@client.info"), "A");
    assert.equal(cohorts.get("zzz@client.info"), "B");
  });

  it("puts a single inbox on A so it stays on in block 0", () => {
    const only = assignClientCohorts(["solo@client.info"]);
    assert.equal(only.get("solo@client.info"), "A");
  });

  it("uses NY ISO weeks for the fortnight block", () => {
    const week1 = new Date("2026-01-01T17:00:00Z");
    assert.equal(isoWeekNumberNy(week1), 1);
    assert.equal(restFortnightBlock(week1), 0);
    assert.equal(onWeekCohort(week1), "A");
    assert.equal(isOffWeek("A", week1), false);
    assert.equal(isOffWeek("B", week1), true);

    const week3 = new Date("2026-01-15T17:00:00Z");
    assert.equal(isoWeekNumberNy(week3), 3);
    assert.equal(restFortnightBlock(week3), 1);
    assert.equal(onWeekCohort(week3), "B");
    assert.equal(isOffWeek("A", week3), true);
    assert.equal(isOffWeek("B", week3), false);
  });

  it("counts NY calendar days until the A/B fortnight swaps", () => {
    const week1Thursday = new Date("2026-01-01T17:00:00Z");
    const fromWeek1 = restRolloverSnapshot(week1Thursday);
    assert.equal(fromWeek1.daysUntil, 4);
    assert.equal(fromWeek1.nextRolloverYmd, "2026-01-05");
    assert.equal(fromWeek1.onWeekCohort, "A");
    assert.equal(fromWeek1.offWeekCohort, "B");
    assert.equal(fromWeek1.fortnightBlock, 0);

    const week2Monday = new Date("2026-01-05T17:00:00Z");
    const fromWeek2 = restRolloverSnapshot(week2Monday);
    assert.equal(fromWeek2.daysUntil, 14);
    assert.equal(fromWeek2.nextRolloverYmd, "2026-01-19");
    assert.equal(fromWeek2.onWeekCohort, "B");
    assert.equal(fromWeek2.fortnightBlock, 1);

    const sundayBeforeSwap = new Date("2026-01-18T17:00:00Z");
    const fromSunday = restRolloverSnapshot(sundayBeforeSwap);
    assert.equal(fromSunday.daysUntil, 1);
    assert.equal(fromSunday.nextRolloverYmd, "2026-01-19");
    assert.equal(fromSunday.onWeekCohort, "B");
  });

  it("walks across a year boundary when week 53 and week 1 share a block", () => {
    // 2026-12-28 is Monday of ISO week 53 (block 0). Week 1 of 2027 is
    // also block 0; the pods swap Monday 2027-01-11 (week 2).
    const week53Monday = new Date("2026-12-28T17:00:00Z");
    assert.equal(isoWeekNumberNy(week53Monday), 53);
    assert.equal(restFortnightBlock(week53Monday), 0);
    const snapshot = restRolloverSnapshot(week53Monday);
    assert.equal(snapshot.daysUntil, 14);
    assert.equal(snapshot.nextRolloverYmd, "2027-01-11");
    assert.equal(snapshot.onWeekCohort, "A");
  });

});
