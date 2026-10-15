import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildComparison } from "./compare.js";

describe("comparison report", () => {
  it("always includes below_launch_bar and missing_signature_tag on both sides", () => {
    const report = buildComparison({
      old: {
        canonCompliant: false,
        canonFindings: {
          understaffed: 30,
          esp_mix: 35,
          below_launch_bar: 4,
          missing_signature_tag: 1,
        },
        placementIsolation: {
          uglyWithoutIsolation: [
            { campaignId: 3847940, campaignName: "SG MSP", inboxPercent: 0 },
          ],
        },
      },
      findings: [{ kind: "understaffed", campaignId: 1, detail: "short 2" }],
      intended: [
        {
          kind: "detach",
          payload: {},
          executed: false,
          shadowed: true,
          writeEnabled: false,
        },
      ],
      scores: [],
    });
    assert.equal(report.diff.uglyOnlyInOld[0], 3847940);
    assert.ok(report.diff.findingsOnlyInOld.includes("esp_mix"));
    assert.ok(report.diff.findingsOnlyInOld.includes("below_launch_bar"));
    assert.ok(report.diff.findingsOnlyInOld.includes("missing_signature_tag"));
    assert.equal(report.v2.canonFindings.below_launch_bar, 0);
    assert.equal(report.v2.canonFindings.missing_signature_tag, 0);
    assert.equal(report.old.canonFindings.below_launch_bar, 4);
    assert.equal(report.diff.intendedDetaches, 1);
    assert.ok(report.notes.some((n) => /copy-canary/.test(n) || /uglyWithoutIsolation/.test(n)));
    assert.doesNotMatch(report.notes.join(" "), /fleet-only/);
    assert.deepEqual(report.espInboxRates, []);
    assert.equal(report.qa.completed, 0);
  });
});
