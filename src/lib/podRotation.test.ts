import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clientIdFromRestGroupKey,
  formatDualPodSlack,
  hasDualPodTags,
  isPodRotationSkippedClient,
  podRotationIdleReason,
} from "./podRotation.js";

describe("podRotation (D223)", () => {
  it("skips PowerGRYD 592842 and Goliath 548611 only", () => {
    assert.equal(isPodRotationSkippedClient(592842), true);
    assert.equal(isPodRotationSkippedClient(548611), true);
    assert.equal(isPodRotationSkippedClient(521881), false);
    assert.equal(clientIdFromRestGroupKey("id:592842"), 592842);
  });

  it("flags dual POD tags and idles on the weekend", () => {
    assert.equal(hasDualPodTags(["POD-A", "POD-B"]), true);
    assert.equal(hasDualPodTags([{ tag_name: "POD-A" }]), false);
    const saturday = new Date("2026-10-03T13:16:00.000Z");
    const monday = new Date("2026-10-05T13:16:00.000Z");
    assert.match(String(podRotationIdleReason(saturday)), /weekend/);
    assert.equal(podRotationIdleReason(monday), undefined);
    const text = formatDualPodSlack([
      { email: "ada@x.com", clientName: "TechEvo", clientId: 77 },
    ]);
    assert.match(text!, /ada@x.com has POD-A and POD-B/);
    assert.doesNotMatch(text!, /—/);
  });
});
