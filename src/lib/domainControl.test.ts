import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buyAheadCount,
  isRetiredSendingDomain,
  judgeDomainCycle,
  nextConsecutiveFails,
} from "./domainControl.js";

describe("domain control rollup", () => {
  it("does not kill a fleet when only one inbox has been tested", () => {
    const verdict = judgeDomainCycle(
      "crosslaunchco.com",
      [{ email: "a@crosslaunchco.com", placement: "SPAM" }],
      ["crosslaunchco.com"],
    );
    assert.equal(verdict.domainFailed, false);
    assert.match(verdict.reason, /not enough/i);
  });

  it("does not kill a fleet on one mailbox", () => {
    const verdict = judgeDomainCycle(
      "crosslaunchco.com",
      [
        { email: "a@crosslaunchco.com", placement: "SPAM" },
        { email: "b@crosslaunchco.com", placement: "PRIMARY" },
        { email: "c@crosslaunchco.com", placement: "PRIMARY" },
      ],
      ["crosslaunchco.com"],
    );
    assert.equal(verdict.domainFailed, false);
    assert.match(verdict.reason, /not enough/i);
  });

  it("kills a fleet only when multiple inboxes fail, including sitters", () => {
    const verdict = judgeDomainCycle(
      "crosslaunchco.com",
      [
        { email: "a@crosslaunchco.com", placement: "SPAM", resting: true },
        { email: "b@crosslaunchco.com", placement: "SPAM" },
        { email: "c@crosslaunchco.com", placement: "SPAM" },
        { email: "d@crosslaunchco.com", placement: "PRIMARY" },
      ],
      ["crosslaunchco.com"],
    );
    assert.equal(verdict.domainFailed, true);
    assert.equal(verdict.failingEmails.length, 3);
    assert.match(verdict.reason, /sitting off campaigns/i);
  });

  it("treats two consecutive domain fails as retire, one as buy-ahead", () => {
    assert.equal(nextConsecutiveFails(0, true), 1);
    assert.equal(nextConsecutiveFails(1, true), 2);
    assert.equal(nextConsecutiveFails(2, false), 0);
    assert.equal(
      buyAheadCount([
        { consecutiveFails: 1 },
        { consecutiveFails: 2, status: "retire_pending" },
        { consecutiveFails: 0 },
      ]),
      1,
    );
  });

  it("a two-inbox client domain can fail with both boxes", () => {
    const verdict = judgeDomainCycle(
      "parlaytechlab.info",
      [
        { email: "a@parlaytechlab.info", placement: "SPAM" },
        { email: "b@parlaytechlab.info", placement: "SPAM" },
      ],
      ["crosslaunchco.com"],
    );
    assert.equal(verdict.domainFailed, true);
  });

  it("treats a retired domain as off-limits for live send", () => {
    assert.equal(
      isRetiredSendingDomain("boldercyperpartnerhqs.info", { status: "retired" }),
      true,
    );
    assert.equal(
      isRetiredSendingDomain("boldercyperpartnerhqs.info", { status: "watch" }),
      false,
    );
    assert.equal(isRetiredSendingDomain("boldercyperpartnerhqs.info", undefined), false);
  });
});
