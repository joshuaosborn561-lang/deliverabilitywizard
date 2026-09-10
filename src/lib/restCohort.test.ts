import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assignClientCohorts,
  isOffWeek,
  isoWeekNumberNy,
  onWeekCohort,
  restFortnightBlock,
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

});
