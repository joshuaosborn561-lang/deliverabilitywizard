import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPodTagName,
  onWeekPodTag,
  POD_A_TAG,
  POD_B_TAG,
  podTagFromAccount,
  podTagFromNames,
  podTagName,
} from "./podTags.js";

describe("podTags", () => {
  it("reads a single POD tag and ignores a mixed pair", () => {
    assert.equal(podTagFromNames(["HOLD-UNTIL-2026-09-01", "POD-A"]), "A");
    assert.equal(podTagFromNames(["pod-b"]), "B");
    assert.equal(podTagFromNames(["POD-A", "POD-B"]), null);
    assert.equal(podTagFromNames(["WARMUP-GATE-EXEMPT"]), null);
    assert.equal(
      podTagFromAccount({
        tags: [{ tag_name: "POD-B" }, { name: "HOLD-UNTIL-2026-09-01" }],
      }),
      "B",
    );
  });

  it("names the on-week tag from the NY fortnight", () => {
    assert.equal(podTagName("A"), POD_A_TAG);
    assert.equal(podTagName("B"), POD_B_TAG);
    assert.equal(onWeekPodTag(new Date("2026-01-01T17:00:00Z")), POD_A_TAG);
    assert.equal(onWeekPodTag(new Date("2026-01-15T17:00:00Z")), POD_B_TAG);
    assert.equal(isPodTagName("POD-A"), true);
    assert.equal(isPodTagName("HOLD-UNTIL-2026-09-01"), false);
  });
});
