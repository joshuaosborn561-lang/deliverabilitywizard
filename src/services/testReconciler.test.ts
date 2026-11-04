import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { TestReconciler } from "./testReconciler.js";

describe("TestReconciler D326", () => {
  const config = loadConfig({ DRY_RUN: "false", ENABLE_TEST_RECONCILER: "true" });
  const slack = { notifyTestReconcile: async () => undefined } as unknown as SlackClient;

  it("links rows by the scanner record and does not count stopped rows as orphans", async () => {
    const state = new StateStore(`/tmp/d326-reconcile-${process.pid}-${Date.now()}.json`);
    await state.load();
    state.markCampaignTested({
      campaignId: 4289133,
      campaignName: "Paused one",
      testedAt: new Date().toISOString(),
      testIds: ["569119"],
      mailboxCount: 40,
      testsCreated: 1,
    });
    state.markCampaignTested({
      campaignId: 4289735,
      campaignName: "Live one",
      testedAt: new Date().toISOString(),
      testIds: ["569168"],
      mailboxCount: 50,
      testsCreated: 1,
    });
    const stoppedIds: string[] = [];
    const sd = {
      listTests: async () => [
        { id: 569119, test_name: "Auto: Paused one", every_days: 1, status: "ACTIVE" },
        { id: 569168, test_name: "Auto: Live one", every_days: 1, status: "ACTIVE" },
        { id: 500001, test_name: "Auto: old", every_days: 1, status: "STOPPED" },
        { id: 500002, test_name: "Auto: unknown", every_days: 1, status: "ACTIVE" },
      ],
      enrichCampaignIds: async (rows: unknown[]) => rows,
      stopAutomatedTest: async (id: string) => {
        stoppedIds.push(String(id));
      },
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => [
        { id: 4289133, status: "PAUSED" },
        { id: 4289735, status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;
    const out = await new TestReconciler(config, smartlead, sd, slack, state).run();
    assert.deepEqual(stoppedIds, ["569119"]);
    assert.equal(out.keptActive, 1);
    assert.deepEqual(out.orphaned, ["500002"]);
  });
});
