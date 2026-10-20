import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KNOWN_SLACK_CAYDEN_USER_ID,
  KNOWN_SLACK_JOSH_USER_ID,
  slackActorIdSanity,
} from "./slackActorIds.js";

describe("D294 Slack actor id sanity", () => {
  it("accepts the known Josh / Cayden ids", () => {
    const check = slackActorIdSanity(
      [KNOWN_SLACK_JOSH_USER_ID],
      [KNOWN_SLACK_CAYDEN_USER_ID],
    );
    assert.equal(check.ok, true);
    assert.equal(check.warnings.length, 0);
    assert.match(check.line, /Josh=U0AAX2XFJE7/);
    assert.match(check.line, /Cayden=U0BL8JT75KN/);
  });

  it("warns when the known ids are swapped", () => {
    const check = slackActorIdSanity(
      [KNOWN_SLACK_CAYDEN_USER_ID],
      [KNOWN_SLACK_JOSH_USER_ID],
    );
    assert.equal(check.ok, false);
    assert.ok(check.warnings.some((row) => /swapped/.test(row)));
    assert.match(check.line, /WARN/);
  });

  it("warns when the same id is on both lists", () => {
    const check = slackActorIdSanity(["USHARED"], ["USHARED"]);
    assert.equal(check.ok, false);
    assert.ok(check.warnings.some((row) => /both Josh and Cayden/.test(row)));
  });
});
