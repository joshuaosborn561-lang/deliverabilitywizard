import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { StateStore } from "../state/store.js";
import { TestReconciler } from "./testReconciler.js";

function memoryState(): StateStore {
  const remediated = new Set<string>();
  return {
    get: () => ({ testedCampaigns: {} }),
    save: async () => {},
    hasRemediation: (key: string) => remediated.has(key),
    markRemediation: (key: string) => {
      remediated.add(key);
    },
  } as unknown as StateStore;
}

describe("TestReconciler", () => {
  it("deletes tests whose campaign is not ACTIVE and keeps ACTIVE ones", async () => {
    const deletedBatches: number[][] = [];
    const stopped: string[] = [];
    const slackMessages: string[] = [];

    const smartDelivery = {
      listTests: async () => [
        {
          spam_test_id: 1,
          test_name: "Auto: Dead",
          every_days: 1,
          status: "ACTIVE",
          campaign_id: 10,
        },
        {
          spam_test_id: 2,
          test_name: "Auto: Live",
          every_days: 1,
          status: "ACTIVE",
          campaign_id: 20,
        },
        {
          spam_test_id: 3,
          test_name: "Auto: Orphan",
          every_days: 1,
          status: "STOPPED",
        },
      ],
      enrichCampaignIds: async (tests: unknown[]) => tests,
      stopAutomatedTest: async (id: string | number) => {
        stopped.push(String(id));
      },
      deleteTests: async (ids: Array<string | number>) => {
        deletedBatches.push(ids.map(Number));
      },
    } as unknown as SmartDeliveryClient;

    const smartlead = {
      listCampaigns: async () => [
        { id: 10, name: "Paused one", status: "PAUSED" },
        { id: 20, name: "Active one", status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;

    const slack = {
      notifyTestReconcile: async (summary: { deleted: unknown[] }) => {
        slackMessages.push(`deleted:${summary.deleted.length}`);
      },
    } as unknown as SlackClient;

    const config = loadConfig({
      ENABLE_TEST_RECONCILER: "true",
      DRY_RUN: "false",
      AUTO_TEST_ACTIVE_STATUSES: "ACTIVE",
    } as NodeJS.ProcessEnv);

    const result = await new TestReconciler(
      config,
      smartlead,
      smartDelivery,
      slack,
      memoryState(),
    ).run();

    assert.equal(result.keptActive, 1);
    assert.deepEqual(stopped, ["1"]);
    assert.ok(result.deleted.some((d) => d.testId === "1"));
    assert.ok(result.deleted.some((d) => d.testId === "3"));
    assert.ok(!result.deleted.some((d) => d.testId === "2"));
    assert.deepEqual(deletedBatches.flat().sort((a, b) => a - b), [1, 3]);
    assert.equal(slackMessages[0], "deleted:2");
  });
});
