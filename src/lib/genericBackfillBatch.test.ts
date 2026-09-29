import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import {
  genericBackfillCampaignIds,
  requestGenericBackfillAsks,
} from "./genericBackfillBatch.js";

function stateFile(): string {
  return `/tmp/gbb-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe("generic backfill batch (D205)", () => {
  it("posts one Slack message for a burst of campaigns", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    let batches = 0;
    let singles = 0;
    const opened = await requestGenericBackfillAsks({
      store: state,
      slack: {
        notifyIsolationAction: async () => {
          singles += 1;
          return { channel: "C", ts: "1" };
        },
        notifyGenericBackfillBatch: async () => {
          batches += 1;
          return { channel: "C", ts: "2" };
        },
      },
      items: [
        { campaignId: 1, campaignName: "A" },
        { campaignId: 2, campaignName: "B" },
        { campaignId: 3, campaignName: "C" },
      ],
    });
    assert.equal(opened.length, 1);
    assert.equal(batches, 1);
    assert.equal(singles, 0);
    assert.deepEqual(genericBackfillCampaignIds(opened[0]!.detail).sort(), [1, 2, 3]);
  });

  it("does not re-ask a campaign already pending", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    await requestGenericBackfillAsks({
      store: state,
      slack: {
        notifyIsolationAction: async () => ({ channel: "C", ts: "1" }),
        notifyGenericBackfillBatch: async () => ({ channel: "C", ts: "2" }),
      },
      items: [{ campaignId: 9, campaignName: "Once" }],
    });
    const again = await requestGenericBackfillAsks({
      store: state,
      slack: {
        notifyIsolationAction: async () => {
          throw new Error("should not post again");
        },
        notifyGenericBackfillBatch: async () => {
          throw new Error("should not batch again");
        },
      },
      items: [{ campaignId: 9, campaignName: "Once" }],
    });
    assert.deepEqual(again, []);
  });
});
