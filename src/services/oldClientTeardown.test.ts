import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import {
  isOldClientCampaign,
  OldClientTeardownService,
} from "./oldClientTeardown.js";

describe("old client teardown (D107)", () => {
  it("matches the three leftover ids and Nieto / MSRS names", () => {
    const ids = [3437329, 3628940, 3628943];
    assert.equal(isOldClientCampaign({ id: 3437329, name: "Anything" }, ids), true);
    assert.equal(
      isOldClientCampaign({ id: 1, name: "Nieto Sports or Airpods" }, ids),
      true,
    );
    assert.equal(
      isOldClientCampaign({ id: 2, name: "MSRS2 Ticket Offer" }, ids),
      true,
    );
    assert.equal(isOldClientCampaign({ id: 3, name: "Positive" }, ids), true);
    assert.equal(
      isOldClientCampaign({ id: 4, name: "Goliath Displacement M" }, ids),
      false,
    );
  });

  it("D111: retries leftover Nieto after the first one-shot pass", async () => {
    const state = new StateStore(
      `/tmp/old-client-retry-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.setOldClientTeardownAt("2026-08-26T04:16:24.646Z");
    const deleted: number[] = [];
    const service = new OldClientTeardownService(
      loadConfig({}),
      {
        deleteCampaign: async (id: number) => {
          deleted.push(id);
        },
      } as never,
      state,
    );
    const result = await service.run({
      campaigns: [
        { id: 3429333, name: "Nieto Astros Offer/Proprietary Tech" },
        { id: 3815447, name: "Goliath Displacement M" },
      ],
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(deleted, [3429333]);
    assert.equal(result.deleted[0]?.campaignId, 3429333);
  });

  it("D111: skips when no old-client campaigns remain", async () => {
    const state = new StateStore(
      `/tmp/old-client-empty-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    let deletes = 0;
    const service = new OldClientTeardownService(
      loadConfig({}),
      {
        deleteCampaign: async () => {
          deletes += 1;
        },
      } as never,
      state,
    );
    const result = await service.run({
      campaigns: [{ id: 3815447, name: "Goliath Displacement M" }],
    });
    assert.equal(result.skipped, true);
    assert.equal(deletes, 0);
  });
});
