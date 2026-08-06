import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  preferSenderInboxRate,
  shouldRotateForPlacement,
} from "./placementRotation.js";
import type { SenderInboxRate } from "../clients/smartdelivery.js";

describe("placementRotation (D32)", () => {
  it("never rotates on a blended score when same-ESP scoring is on", () => {
    assert.equal(
      shouldRotateForPlacement(
        { inboxRate: 40, scoredSameEsp: false },
        80,
        { scoreSameEspOnly: true },
      ),
      false,
    );
    assert.equal(
      shouldRotateForPlacement(
        { inboxRate: 40, scoredSameEsp: true },
        80,
        { scoreSameEspOnly: true },
      ),
      true,
    );
  });

  it("does not let a blended row overwrite a same-ESP row", () => {
    const same: SenderInboxRate = {
      email: "a@x.com",
      inboxRate: 90,
      scoredSameEsp: true,
    };
    const blended: SenderInboxRate = {
      email: "a@x.com",
      inboxRate: 20,
      scoredSameEsp: false,
    };
    assert.equal(
      preferSenderInboxRate(same, blended, { scoreSameEspOnly: true }),
      same,
    );
    assert.equal(
      preferSenderInboxRate(blended, same, { scoreSameEspOnly: true }),
      same,
    );
  });
});
