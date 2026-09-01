import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  freshBounceSamples,
  isLiveBounceBurst,
  shouldPauseCampaignForBounceBurst,
} from "./campaignBouncePause.js";

describe("D141 bounce pause trips", () => {
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

  it("splits live bounced sends from ledger residue on sent_time", () => {
    // The 2026-08-27 false positive: a two-week backlog batch-recorded as
    // "12 new bounces in 10 minutes" while every send was days old.
    const now = Date.parse("2026-08-27T01:10:00.000Z");
    const stale = freshBounceSamples(
      [
        { sent_time: "2026-08-13T14:05:53.775Z" },
        { sent_time: "2026-08-20T16:34:22.414Z" },
        { sent_time: "2026-08-24T17:06:36.434Z" },
        { no_sent_time: true },
      ],
      now,
    );
    assert.deepEqual(stale, {
      readable: 3,
      fresh: 0,
      newestSentAt: "2026-08-24T17:06:36.434Z",
    });

    const mixed = freshBounceSamples(
      [
        { sent_time: "2026-08-13T14:05:53.775Z" },
        { sent_time: "2026-08-27T00:55:00.000Z" },
      ],
      now,
    );
    assert.equal(mixed.fresh, 1);
    assert.equal(mixed.readable, 2);
    assert.equal(
      isLiveBounceBurst(mixed),
      false,
      "one fresh send among stale rows is still a dump, not a live burst",
    );
    assert.equal(isLiveBounceBurst(stale), false);
    assert.equal(
      isLiveBounceBurst({ readable: 12, fresh: 10, newestSentAt: null }),
      false,
      "exactly 10 fresh samples is not more than 10",
    );
    assert.equal(
      isLiveBounceBurst({ readable: 13, fresh: 11, newestSentAt: null }),
      true,
      "more than 10 fresh sampled sends substantiates the burst",
    );
  });

  it("reads nothing into rows without a parseable sent_time", () => {
    assert.deepEqual(freshBounceSamples([{}, { sent_time: "garbage" }], 0), {
      readable: 0,
      fresh: 0,
      newestSentAt: null,
    });
  });
});
