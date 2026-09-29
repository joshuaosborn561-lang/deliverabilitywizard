import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import { StateStore } from "../state/store.js";
import { HoldEnforcementService } from "./holdEnforcement.js";

function stateFile(): string {
  return `/tmp/hold-enf-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe("HoldEnforcementService (D205)", () => {
  it("pauses an ACTIVE hold campaign and Slacks one line", async () => {
    const statuses: Array<[number, string]> = [];
    const slack: string[] = [];
    const state = new StateStore(stateFile());
    await state.load();
    const service = new HoldEnforcementService(
      loadConfig({ DRY_RUN: "false" }),
      {
        updateCampaignStatus: async (id: number, status: string) => {
          statuses.push([id, status]);
        },
      } as unknown as SmartleadClient,
      {
        send: async (text: string) => {
          slack.push(text);
        },
      } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: new Date("2026-09-29T15:00:00Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [],
        accounts: [],
        campaigns: [
          { id: 3847837, name: "Parlay SEG A", status: "ACTIVE", client_id: 418274 },
          { id: 3847839, name: "Parlay SEG B", status: "PAUSED", client_id: 418274 },
          { id: 1, name: "TechEvo live", status: "ACTIVE", client_id: 521881 },
        ],
      },
    });
    assert.deepEqual(statuses, [[3847837, "PAUSED"]]);
    assert.equal(result.paused.length, 1);
    assert.equal(result.alreadyPaused, 1);
    assert.equal(slack.length, 1);
    assert.match(slack[0]!, /Parlay SEG A/);
  });

  it("pauses Goliath ACTIVE campaigns through 2026-10-15 and not after", async () => {
    const statuses: Array<[number, string]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const service = new HoldEnforcementService(
      loadConfig({ DRY_RUN: "false" }),
      {
        updateCampaignStatus: async (id: number, status: string) => {
          statuses.push([id, status]);
        },
      } as unknown as SmartleadClient,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const inventory = {
      fetchedAt: Date.now(),
      clients: [],
      accounts: [],
      campaigns: [
        { id: 99, name: "Goliath Displacement", status: "ACTIVE", client_id: 548611 },
      ],
    };
    const during = await service.run({
      dryRun: false,
      now: new Date("2026-10-15T17:00:00Z"),
      inventory,
    });
    assert.equal(during.paused.length, 1);
    statuses.length = 0;
    const after = await service.run({
      dryRun: false,
      now: new Date("2026-10-16T17:00:00Z"),
      inventory,
    });
    assert.equal(after.paused.length, 0);
    assert.deepEqual(statuses, []);
  });
});
