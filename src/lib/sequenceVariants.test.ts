import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sequenceVariantTargets,
  uncoveredVariants,
  variantLabelFromTestName,
  variantTestSuffix,
} from "./sequenceVariants.js";
import { canaryCopyTestName, campaignIdFromCanaryTestName } from "./isolationNames.js";
import { hasLivingUnwarmedCopyCanary, livingVariantCopyCanaryId } from "./canaryCoverage.js";

describe("D303 per-variant tests", () => {
  const seq = {
    id: 10,
    seq_number: 1,
    sequence_variants: [
      { id: 101, subject: "s-a", email_body: "a", variant_label: "A" },
      { id: 102, subject: "s-b", email_body: "b", variant_label: "B" },
      { id: 103, subject: "s-c", email_body: "c" },
    ],
  };
  it("one target per A/B variant with its own mapping id", () => {
    const t = sequenceVariantTargets(seq);
    assert.deepEqual(t.map((x) => [x.key, x.mappingId]), [["A", 101], ["B", 102], ["C", 103]]);
  });
  it("a step with no variants yields one target on the step id", () => {
    const t = sequenceVariantTargets({ id: 7, seq_number: 1, subject: "x" });
    assert.equal(t.length, 1);
    assert.equal(t[0]!.mappingId, 7);
  });
  it("suffix only when there are 2+ variants, and parses back", () => {
    assert.equal(variantTestSuffix({ label: "B" }, 1), "");
    assert.equal(variantTestSuffix({ label: "B" }, 2), " [variant B]");
    assert.equal(variantLabelFromTestName("Auto: X [variant B]"), "B");
  });
  it("legacy campaign coverage counts as variant A only", () => {
    const t = sequenceVariantTargets(seq);
    const owed = uncoveredVariants(t, { keys: null, legacyCampaignCovered: true });
    assert.deepEqual(owed.map((x) => x.key), ["B", "C"]);
    const owed2 = uncoveredVariants(t, { keys: ["A", "B"] });
    assert.deepEqual(owed2.map((x) => x.key), ["C"]);
  });
  it("variant canary names keep the campaign id and do not cover the primary", () => {
    const name = canaryCopyTestName(55, "Camp", " [variant B]");
    assert.equal(campaignIdFromCanaryTestName(name), 55);
    const tests = [
      { id: 9, test_name: name, test_type: "automated", status: "ACTIVE" },
    ] as never[];
    assert.equal(hasLivingUnwarmedCopyCanary(55, tests), false);
    assert.equal(livingVariantCopyCanaryId(55, "B", tests), "9");
  });
});
