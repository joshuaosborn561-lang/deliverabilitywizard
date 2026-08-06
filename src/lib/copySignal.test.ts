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

  it("treats a single weak provider as mailbox/ESP local", () => {
    const signal = classifyCopySignal([
      { name: "Gmail", inboxPercent: 40 },
      { name: "Outlook", inboxPercent: 90 },
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
});
