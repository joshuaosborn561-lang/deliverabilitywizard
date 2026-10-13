import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  displayShortfallSenders,
  displayStaffedSenders,
  scrubSenderFloat,
} from "./displaySenderCount.js";
import { formatCanonStaffFloorDetail } from "./canonStaffable.js";
import {
  groupShortStaffedByClient,
  shortStaffedLines,
} from "./shortStaffedSlack.js";

describe("D259 — whole-sender Slack / human display", () => {
  it("scrubs float noise to 1e-6, then ceils shortfalls and floors staffed", () => {
    assert.equal(scrubSenderFloat(233.99999999999991), 234);
    assert.equal(displayShortfallSenders(233.99999999999991), 234);
    assert.equal(displayShortfallSenders(51.5), 52);
    assert.equal(displayShortfallSenders(0.1), 1);
    assert.equal(displayShortfallSenders(0.0000004), 0);
    assert.equal(displayStaffedSenders(21.500000000000014), 21);
    assert.equal(displayStaffedSenders(21.49999999999999), 21);
    assert.equal(displayStaffedSenders(39.999999999), 40);
    assert.equal(displayStaffedSenders(0.1), 0);
  });

  it("short-staffed Slack and CANON lines show whole senders", () => {
    const text = shortStaffedLines(
      groupShortStaffedByClient([
        { clientId: 574020, clientName: "EMCOR", name: "EMCOR A", shortBy: 233.99999999999991 },
        { clientId: 582890, clientName: "Insight", name: "Insight A", shortBy: 51.5 },
      ]),
    );
    assert.match(text ?? "", /EMCOR is short 234 staffable/);
    assert.match(text ?? "", /Insight is short 52 staffable/);
    assert.doesNotMatch(text ?? "", /233\.999|51\.5/);
    assert.match(
      formatCanonStaffFloorDetail({
        staffable: 21.500000000000014,
        linked: 22,
      }),
      /on-week staffable 21\/40/,
    );
    assert.doesNotMatch(
      formatCanonStaffFloorDetail({
        staffable: 21.500000000000014,
        linked: 22,
      }),
      /21\.500000000000014/,
    );
  });
});
