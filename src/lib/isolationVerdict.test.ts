import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideIsolationVerdict,
  failedControlIsNeverCopy,
} from "./isolationVerdict.js";

describe("isolation verdict", () => {
  it("campaign spam + clean senders is COPY and starts teardown", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY", "PRIMARY"],
    });
    assert.equal(result.verdict, "COPY");
    assert.equal(result.startCopyTeardown, true);
    assert.equal(failedControlIsNeverCopy(result), true);
  });

  it("campaign spam + failing senders is INFRA and never COPY", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["SPAM", "PRIMARY"],
    });
    assert.equal(result.verdict, "INFRA");
    assert.equal(result.startCopyTeardown, false);
    assert.equal(result.pullInfraDiagnostics, true);
    assert.equal(failedControlIsNeverCopy(result), true);
  });

  it("a failed rig control is not a copy finding for teardown", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY"],
      rig: { controlPrimary: false, copyPrimary: false },
    });
    assert.equal(result.verdict, "COPY");
    assert.equal(result.startCopyTeardown, false);
    assert.match(result.reason, /word hunt is on hold/i);
  });

  it("rig control primary + copy primary is list/offer, not copy", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY"],
      rig: { controlPrimary: true, copyPrimary: true },
    });
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.equal(result.startCopyTeardown, false);
  });

  it("insufficient control is inconclusive", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["UNKNOWN"],
    });
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.equal(failedControlIsNeverCopy(result), true);
  });
});
