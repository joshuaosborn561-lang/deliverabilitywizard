import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  existingPodTag,
  mayWritePodTag,
  seatIsUntaggedForPod,
} from "./podTagLock.js";

describe("D234 POD tag lock", () => {
  it("allows a first tag only on an untagged seat", () => {
    assert.equal(existingPodTag([]), null);
    assert.equal(seatIsUntaggedForPod([{ tag_name: "GENERIC" }]), true);
    assert.equal(mayWritePodTag([{ tag_name: "GENERIC" }], "A"), true);
    assert.equal(mayWritePodTag([{ tag_name: "GENERIC" }], "B"), true);
  });

  it("refuses A→B and B→A on an already-tagged seat", () => {
    assert.equal(existingPodTag([{ tag_name: "POD-A" }]), "A");
    assert.equal(mayWritePodTag([{ tag_name: "POD-A" }], "B"), false);
    assert.equal(mayWritePodTag([{ tag_name: "POD-B" }], "A"), false);
    assert.equal(mayWritePodTag([{ tag_name: "POD-A" }], "A"), true);
    assert.equal(seatIsUntaggedForPod([{ tag_name: "POD-B" }]), false);
  });
});
