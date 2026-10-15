import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildComparison } from "./compare.js";

describe("comparison report", () => {
  it("diffs old wizard 0% ugly against v2 fleet-filtered findings", () => {
    const report = buildComparison({
      old: {
        canonCompliant: false,
        canonFindings: { understaffed: 30, esp_mix: 35 },
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
    assert.equal(report.diff.intendedDetaches, 1);
    assert.ok(
      report.notes.some((n) => /fleet-only/.test(n) || /uglyWithoutIsolation/.test(n)),
    );
  });
});
