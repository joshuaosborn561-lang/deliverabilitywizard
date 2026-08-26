import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shouldPauseCampaignForBounceBurst,
  shouldPauseCampaignForBounceRate,
} from "./campaignBouncePause.js";

describe("D90 bounce pause trips", () => {
  it("rate needs 1k leads and strictly more than 10%", () => {
    assert.equal(shouldPauseCampaignForBounceRate(999, 200), false);
    assert.equal(shouldPauseCampaignForBounceRate(1000, 100), false);
    assert.equal(shouldPauseCampaignForBounceRate(1000, 101), true);
    assert.equal(shouldPauseCampaignForBounceRate(2000, 200), false);
    assert.equal(shouldPauseCampaignForBounceRate(2000, 201), true);
  });

  it("the old 20/7 mid-volume sample does not trip the rate rule", () => {
    assert.equal(shouldPauseCampaignForBounceRate(150, 40), false);
    assert.equal(shouldPauseCampaignForBounceRate(500, 40), false);
  });

  it("burst is more than 10 new bounces inside the snapshot window", () => {
    const now = Date.parse("2026-08-26T02:10:00.000Z");
    const prev = {
      bounced: 4,
      sent: 40,
      at: "2026-08-26T02:00:00.000Z",
    };
    assert.deepEqual(
      shouldPauseCampaignForBounceBurst(prev, 14, now),
      { trip: false, delta: 10 },
    );
    assert.deepEqual(
      shouldPauseCampaignForBounceBurst(prev, 15, now),
      { trip: true, delta: 11 },
    );
    assert.deepEqual(
      shouldPauseCampaignForBounceBurst(undefined, 20, now),
      { trip: false, delta: 0 },
    );
    assert.deepEqual(
      shouldPauseCampaignForBounceBurst(
        { ...prev, at: "2026-08-26T01:50:00.000Z" },
        20,
        now,
      ),
      { trip: false, delta: 0 },
    );
  });
});
