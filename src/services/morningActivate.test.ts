import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { matchesMorningBook, MorningActivateService } from "./morningActivate.js";

describe("morning activate (D109)", () => {
  it("matches the live book and not a shell leftover", () => {
    const patterns = loadConfig({} as NodeJS.ProcessEnv).morningActivatePatterns;
    assert.equal(matchesMorningBook("Goliath Displacement M 201-500 CIO", patterns), true);
    assert.equal(matchesMorningBook("BCP Logistics Over-1k", patterns), true);
    assert.equal(matchesMorningBook("Peterson - C1 General Contractors", patterns), true);
    assert.equal(matchesMorningBook("Parlay2 Sports Offer - copy", patterns), true);
    assert.equal(matchesMorningBook("TechEvo New England Red Sox", patterns), true);
    assert.equal(matchesMorningBook("Nieto Sports or Airpods", patterns), false);
  });

  it("D114: does not START a canary shell whose name contains Goliath", async () => {
    const state = new StateStore(
      `/tmp/morning-canary-shell-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const started: number[] = [];
    const service = new MorningActivateService(
      loadConfig({} as NodeJS.ProcessEnv),
      {
        listCampaigns: async () => [
          {
            id: 88,
            name: "Canary shell: #3781910 Goliath L2 Healthcare Tickets",
            status: "PAUSED",
          },
        ],
        listClients: async () => [],
        updateCampaignStatus: async (id: number) => {
          started.push(id);
        },
      } as unknown as SmartleadClient,
      state,
    );
    const result = await service.run({ dryRun: false });
    assert.deepEqual(started, []);
    assert.ok(result.blocked.some((row) => row.includes("shell stays paused")));
  });
});
