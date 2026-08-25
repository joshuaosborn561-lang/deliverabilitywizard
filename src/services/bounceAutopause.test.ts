import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { BounceAutopauseService } from "./bounceAutopause.js";

describe("BounceAutopauseService", () => {
  it("writes 20 on Goliath / Under-1k and 7 on Over-1k (D78)", async () => {
    const wrote: Array<{ id: number; threshold: unknown }> = [];
    const service = new BounceAutopauseService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "BCP Healthcare Under-1k (No Team)" },
          { id: 2, name: "BCP Healthcare Over-1k (No Team)" },
          { id: 3, name: "Goliath Displacement L 501-1000" },
          { id: 4, name: "Vasco - Service - Nissan" },
          { id: 9, name: "Pod control shell" },
        ],
        updateCampaignSettings: async (id: number, body: Record<string, unknown>) => {
          wrote.push({ id, threshold: body.bounce_autopause_threshold });
        },
      } as unknown as SmartleadClient,
    );

    const result = await service.run({ dryRun: false });
    assert.equal(result.updated, 4);
    assert.deepEqual(wrote, [
      { id: 1, threshold: "20" },
      { id: 2, threshold: "7" },
      { id: 3, threshold: "20" },
      { id: 4, threshold: "7" },
    ]);
  });

  it("never starts a paused campaign", async () => {
    const src = await readFile(new URL("./bounceAutopause.ts", import.meta.url), "utf8");
    assert.equal(/updateCampaignStatus\([^)]*START/.test(src), false);
  });
});
