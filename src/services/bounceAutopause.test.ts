import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { BounceAutopauseService } from "./bounceAutopause.js";

function client(opts: {
  campaigns: Array<{ id: number; name: string; status?: string }>;
  onUpdate?: (id: number, body: Record<string, unknown>) => void;
}): SmartleadClient {
  return {
    listCampaigns: async () => opts.campaigns,
    updateCampaignSettings: async (id: number, body: Record<string, unknown>) => {
      opts.onUpdate?.(id, body);
    },
  } as unknown as SmartleadClient;
}

describe("BounceAutopauseService", () => {
  it("sets Under-1k campaigns to 20% and leaves Over-1k / Goliath bands alone", async () => {
    const wrote: Array<{ id: number; threshold: unknown }> = [];
    const service = new BounceAutopauseService(
      loadConfig({}),
      client({
        campaigns: [
          { id: 3763800, name: "BCP Healthcare Under-1k (No Team)", status: "ACTIVE" },
          { id: 3763799, name: "BCP Healthcare Under-1k (With Team)", status: "PAUSED" },
          { id: 3763802, name: "BCP Healthcare Over-1k (No Team)", status: "ACTIVE" },
          { id: 3815448, name: "Goliath Displacement L 501-1000", status: "ACTIVE" },
        ],
        onUpdate: (id, body) => {
          wrote.push({ id, threshold: body.bounce_autopause_threshold });
        },
      }),
    );

    const result = await service.run({ dryRun: false });
    assert.equal(result.matched, 2);
    assert.equal(result.updated, 2);
    assert.deepEqual(wrote, [
      { id: 3763800, threshold: "20" },
      { id: 3763799, threshold: "20" },
    ]);
  });

  it("does not write in dry-run", async () => {
    let updates = 0;
    const service = new BounceAutopauseService(
      loadConfig({}),
      client({
        campaigns: [
          { id: 1, name: "BCP Logistics Under-1k (No Team)" },
        ],
        onUpdate: () => {
          updates += 1;
        },
      }),
    );
    const result = await service.run({ dryRun: true });
    assert.equal(result.updated, 1);
    assert.equal(updates, 0);
  });

  it("never starts a paused campaign", async () => {
    const src = await readFile(new URL("./bounceAutopause.ts", import.meta.url), "utf8");
    assert.equal(
      /updateCampaignStatus\([^)]*START/.test(src),
      false,
    );
  });
});
