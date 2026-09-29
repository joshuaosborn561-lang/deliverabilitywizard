import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import { StateStore } from "../state/store.js";
import {
  countPowerGrydDedicatedSeats,
  PowerGrydWatchService,
} from "./powerGrydWatch.js";

function stateFile(): string {
  return `/tmp/pgw-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe("PowerGrydWatchService (D205)", () => {
  it("counts dedicated seats by client_id and alerts once per drop", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const slack: string[] = [];
    const accounts = Array.from({ length: 31 }, (_, i) => ({
      id: i + 1,
      from_email: `pg-${i}@pool.info`,
      client_id: 592842,
      campaign_ids: [10],
    }));
    const inventory = {
      fetchedAt: Date.now(),
      clients: [{ id: 592842, name: "PowerGRYD", logo: "PowerGRYD" }],
      campaigns: [{ id: 10, name: "PowerGRYD live", status: "ACTIVE", client_id: 592842 }],
      accounts,
    };
    const counted = countPowerGrydDedicatedSeats({
      accounts,
      campaigns: inventory.campaigns,
      clients: inventory.clients,
      state,
      config: loadConfig({}),
      clientId: 592842,
    });
    assert.equal(counted.count, 31);

    const service = new PowerGrydWatchService(
      loadConfig({ DRY_RUN: "false" }),
      { send: async (text: string) => { slack.push(text); } } as unknown as SlackClient,
      state,
    );
    const first = await service.run({ dryRun: false, inventory });
    assert.equal(first.dedicatedSeats, 31);
    assert.equal(first.alerted, false);
    assert.equal(slack.length, 0);

    inventory.accounts = accounts.slice(0, 30);
    const drop = await service.run({ dryRun: false, inventory });
    assert.equal(drop.dedicatedSeats, 30);
    assert.equal(drop.alerted, true);
    assert.equal(slack.length, 1);
    assert.match(slack[0]!, /31 → 30/);

    const again = await service.run({ dryRun: false, inventory });
    assert.equal(again.alerted, false);
    assert.equal(slack.length, 1);
  });

  it("does not call Smartlead writes", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./powerGrydWatch.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(src, /updateCampaignStatus|addEmailAccounts|removeEmailAccounts/);
  });
});
