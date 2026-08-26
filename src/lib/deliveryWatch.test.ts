import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectDeliveryCollapse, oooDetectionEnabled } from "./deliveryWatch.js";

describe("delivery watch", () => {
  it("hits when replies and out-of-office collapse and bounces stay flat", () => {
    const hit = detectDeliveryCollapse({
      yesterday: { replies: 11, ooo: 6, bounceRate: 1.2 },
      today: { replies: 0, ooo: 0, bounceRate: 1.1 },
      infraUnchanged: true,
      sequenceUnchanged: true,
      listUnchanged: true,
    });
    assert.equal(hit.hit, true);
    assert.match(hit.reason, /nothing is being delivered/i);
  });

  it("does not hit on a bounce spike or a changed sequence", () => {
    assert.equal(
      detectDeliveryCollapse({
        yesterday: { replies: 11, ooo: 6, bounceRate: 1 },
        today: { replies: 0, ooo: 0, bounceRate: 8 },
        infraUnchanged: true,
        sequenceUnchanged: true,
        listUnchanged: true,
      }).hit,
      false,
    );
    assert.equal(
      detectDeliveryCollapse({
        yesterday: { replies: 11, ooo: 6, bounceRate: 1 },
        today: { replies: 0, ooo: 0, bounceRate: 1 },
        infraUnchanged: true,
        sequenceUnchanged: false,
        listUnchanged: true,
      }).hit,
      false,
    );
  });

  it("reads out-of-office detection from campaign settings", () => {
    assert.equal(
      oooDetectionEnabled({
        out_of_office_detection_settings: { enabled: true },
      }),
      true,
    );
    assert.equal(
      oooDetectionEnabled({
        out_of_office_detection_settings: { enabled: false },
      }),
      false,
    );
  });
});
