import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCopySignal,
  shouldDeferSenderRotationForCopy,
} from "./copySignal.js";

describe("copySignal", () => {
  it("flags Outlook-buried + Gmail-ok as copy_likely", () => {
    const signal = classifyCopySignal([
      { name: "Outlook", inboxPercent: 8 },
      { name: "Gmail", inboxPercent: 72 },
    ]);
    assert.equal(signal.kind, "copy_likely");
    assert.equal(shouldDeferSenderRotationForCopy(signal), true);
  });

  // D36 changed this expectation deliberately. Gmail 40 against Outlook 90 is a
  // 50-point split on the same senders, which a broken mailbox cannot produce —
  // it would be weak on both. It now reads as copy, not mailbox-local.
  it("treats a wide provider split as copy, not mailbox-local (D36)", () => {
    const signal = classifyCopySignal([
      { name: "Gmail", inboxPercent: 40 },
      { name: "Outlook", inboxPercent: 90 },
    ]);
    assert.equal(signal.kind, "copy_likely");
    assert.equal(shouldDeferSenderRotationForCopy(signal), true);
  });

  it("still treats a narrow single-provider dip as mailbox/ESP local", () => {
    // 28 points apart — under COPY_DIVERGENCE_POINTS, so the local reading stands.
    const signal = classifyCopySignal([
      { name: "Gmail", inboxPercent: 72 },
      { name: "Outlook", inboxPercent: 100 },
    ]);
    assert.equal(signal.kind, "mailbox_or_esp");
    assert.equal(shouldDeferSenderRotationForCopy(signal), false);
  });

  it("marks multi-provider weakness as ambiguous", () => {
    const signal = classifyCopySignal([
      { name: "Gmail", inboxPercent: 25 },
      { name: "Outlook", inboxPercent: 30 },
    ]);
    assert.equal(signal.kind, "ambiguous");
  });

  describe("D36 — divergence is provider-agnostic", () => {
    // Real numbers from Goliath L3 Manufacturing Defense, 2026-08-12. Identical
    // 100 senders on both campaigns; only the offer differs.
    it("flags the Gmail-buried AirPods offer that the old rule missed", () => {
      const signal = classifyCopySignal([
        { name: "Office365", inboxPercent: 100 },
        { name: "G Suite", inboxPercent: 36.4 },
      ]);
      assert.equal(signal.kind, "copy_likely");
      assert.equal(shouldDeferSenderRotationForCopy(signal), true);
      assert.match(signal.reason, /G Suite/);
      assert.match(signal.reason, /64-point|63-point/);
    });

    it("leaves the healthy Tickets offer alone", () => {
      const signal = classifyCopySignal([
        { name: "Office365", inboxPercent: 100 },
        { name: "G Suite", inboxPercent: 100 },
      ]);
      assert.equal(signal.kind, "none");
    });

    it("does not fire when the healthy side is itself below threshold", () => {
      // Everything weak stays ambiguous — could be the domain, not the copy.
      const signal = classifyCopySignal([
        { name: "Office365", inboxPercent: 60 },
        { name: "G Suite", inboxPercent: 10 },
      ]);
      assert.notEqual(signal.kind, "copy_likely");
    });

    it("still flags the original Outlook-buried direction", () => {
      const signal = classifyCopySignal([
        { name: "Office365", inboxPercent: 15 },
        { name: "G Suite", inboxPercent: 100 },
      ]);
      assert.equal(signal.kind, "copy_likely");
    });

    it("needs a real split, not a single provider", () => {
      const signal = classifyCopySignal([{ name: "G Suite", inboxPercent: 40 }]);
      assert.notEqual(signal.kind, "copy_likely");
    });
  });
});
