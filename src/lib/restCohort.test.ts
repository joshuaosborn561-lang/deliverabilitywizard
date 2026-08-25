import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assignClientCohorts,
  isOffWeek,
  isoWeekNumberNy,
  onWeekCohort,
  resolveClientCohorts,
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

  it("keeps an existing POD tag when resolving cohorts (D68)", () => {
    const resolved = resolveClientCohorts([
      { email: "a@client.info", tagged: "B" },
      { email: "b@client.info", tagged: null },
      { email: "m@client.info", tagged: null },
      { email: "z@client.info", tagged: null },
    ]);
    assert.equal(resolved.get("a@client.info"), "B");
    assert.equal(resolved.get("b@client.info"), "A");
    assert.equal(resolved.get("m@client.info"), "A");
    assert.equal(resolved.get("z@client.info"), "B");
  });

  it("matches assignClientCohorts when nobody is tagged yet", () => {
    const emails = ["z@client.info", "a@client.info", "m@client.info", "b@client.info"];
    const computed = assignClientCohorts(emails);
    const resolved = resolveClientCohorts(emails.map((email) => ({ email, tagged: null })));
    assert.deepEqual([...resolved.entries()].sort(), [...computed.entries()].sort());
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
