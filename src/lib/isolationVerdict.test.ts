import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideIsolationVerdict,
  failedControlIsNeverCopy,
} from "./isolationVerdict.js";

describe("isolation verdict", () => {
  it("campaign spam + clean senders is COPY only after unwarmed copy also failed", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY", "PRIMARY"],
      knownGoodFineAcrossEsps: true,
      unwarmedCopyFineAcrossEsps: false,
    });
    assert.equal(result.verdict, "COPY");
    assert.equal(result.startCopyTeardown, true);
    assert.equal(failedControlIsNeverCopy(result), true);
  });

  it("D96: no unwarmed-copy reading is not a word hunt", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY", "PRIMARY"],
      knownGoodFineAcrossEsps: true,
    });
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.equal(result.startCopyTeardown, false);
  });

  it("D96: unwarmed senders landing that copy is INFRA", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY", "PRIMARY"],
      knownGoodFineAcrossEsps: true,
      unwarmedCopyFineAcrossEsps: true,
    });
    assert.equal(result.verdict, "INFRA");
    assert.equal(result.startCopyTeardown, false);
    assert.equal(result.pullInfraDiagnostics, true);
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

  it("a failed rig control still starts teardown when the rig has mailboxes", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY"],
      unwarmedCopyFineAcrossEsps: false,
      rig: { controlPrimary: false, copyPrimary: false, mailboxCount: 2 },
    });
    assert.equal(result.verdict, "COPY");
    assert.equal(result.startCopyTeardown, true);
  });

  it("COPY with an unarmed rig waits instead of leaving the hunt unstarted", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY"],
      unwarmedCopyFineAcrossEsps: false,
      rig: { controlPrimary: false, copyPrimary: false, mailboxCount: 0 },
    });
    assert.equal(result.verdict, "COPY");
    assert.equal(result.startCopyTeardown, false);
    assert.match(result.reason, /waits until the rig is armed/i);
  });

  it("D158: content_block + ugly canary is COPY even with no mailbox tag", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["UNKNOWN"],
      contentBlock: true,
      unwarmedCopyFineAcrossEsps: false,
      knownGoodFineAcrossEsps: true,
    });
    assert.equal(result.verdict, "COPY");
    assert.equal(result.control, "INSUFFICIENT");
    assert.equal(result.startCopyTeardown, true);
    assert.equal(failedControlIsNeverCopy(result), true);
  });

  it("D158: content_block + known-good also failing is INFRA", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["UNKNOWN"],
      contentBlock: true,
      unwarmedCopyFineAcrossEsps: false,
      knownGoodFineAcrossEsps: false,
    });
    assert.equal(result.verdict, "INFRA");
    assert.equal(result.startCopyTeardown, false);
  });

  it("rig control primary + copy primary is list/offer, not copy", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY"],
      unwarmedCopyFineAcrossEsps: false,
      rig: { controlPrimary: true, copyPrimary: true },
    });
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.equal(result.startCopyTeardown, false);
  });

  it("unwarmed landing campaign copy while warmed fail is INFRA", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY", "PRIMARY"],
      copyCanary: {
        unwarmedLanded: true,
        warmedLanded: false,
        unwarmedTested: 3,
        warmedTested: 40,
        unwarmedInbox: 3,
        warmedInbox: 8,
      },
    });
    assert.equal(result.verdict, "INFRA");
    assert.equal(result.startCopyTeardown, false);
    assert.equal(failedControlIsNeverCopy(result), true);
  });

  it("cold fail + warmed land is not a word hunt", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY"],
      copyCanary: {
        unwarmedLanded: false,
        warmedLanded: true,
        unwarmedTested: 3,
        warmedTested: 40,
        unwarmedInbox: 0,
        warmedInbox: 38,
      },
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

  it("D96: warmed and unwarmed both burying is COPY", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY"],
      knownGoodFineAcrossEsps: true,
      copyCanary: {
        unwarmedLanded: false,
        warmedLanded: false,
        unwarmedTested: 3,
        warmedTested: 40,
        unwarmedInbox: 0,
        warmedInbox: 5,
      },
    });
    assert.equal(result.verdict, "COPY");
    assert.equal(result.startCopyTeardown, true);
  });

  it("D93: campaign ESP fail + known-good also failing an ESP is INFRA", () => {
    const result = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["PRIMARY", "PRIMARY"],
      knownGoodFineAcrossEsps: false,
    });
    assert.equal(result.verdict, "INFRA");
    assert.equal(result.startCopyTeardown, false);
    assert.equal(failedControlIsNeverCopy(result), true);
  });
});
