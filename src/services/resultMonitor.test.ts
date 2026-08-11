import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { StateStore } from "../state/store.js";
import { ResultMonitor } from "./resultMonitor.js";

const googleAuth = {
  spf_result: { spf: "google.com: domain of x@brand.com designates 1.2.3.4" },
};
const outlookAuth = {
  spf_result: { spf: "pass (protection.outlook.com: domain of brand.com)" },
};

/**
 * One OUTLOOK sender. Its Microsoft seeds all inbox; its Google seeds all
 * spam. Blended = 50%, same-ESP (Microsoft) = 100%. Remediation scores the
 * same-ESP number, so the alert must quote 100 and not threaten a rotation.
 */
function senderReport() {
  return [
    {
      email: "outlook-sender@brand.com",
      details: [
        { reply: { mail_folder: "Inbox", ...outlookAuth } },
        { reply: { mail_folder: "Inbox", ...outlookAuth } },
        { reply: { mail_folder: "Inbox", ...outlookAuth } },
        { reply: { mail_folder: "Spam", ...googleAuth } },
        { reply: { mail_folder: "Spam", ...googleAuth } },
        { reply: { mail_folder: "Spam", ...googleAuth } },
      ],
    },
  ];
}

function fakeState(): StateStore {
  return {
    get: () => ({ testedCampaigns: {} }),
    hasAlert: () => false,
    markAlert: () => undefined,
    setLastMonitorAt: () => undefined,
    save: async () => undefined,
  } as unknown as StateStore;
}

function fakeSmartDelivery(): SmartDeliveryClient {
  return {
    listTests: async () => [{ id: "t1", test_name: "Test One" }],
    getProviderwiseReport: async () => ({
      result: [
        // Below the deliverability threshold so the alert path runs.
        { provider_name: "Outlook", inbox_rate: 40 },
      ],
    }),
    getSenderAccountReport: async () => senderReport(),
    getDomainBlacklist: async () => [],
    getIpBlacklist: async () => [],
    getMailboxSummary: async () => [],
  } as unknown as SmartDeliveryClient;
}

type Captured = {
  senders?: Array<{
    email: string;
    inboxPercent: number;
    scoredSameEsp?: boolean;
    willRemediate?: boolean;
  }>;
};

function fakeSlack(captured: Captured): SlackClient {
  return {
    send: async () => undefined,
    notifyPlacementResult: async (payload: Captured) => {
      captured.senders = payload.senders;
    },
    notifyBlacklist: async () => undefined,
  } as unknown as SlackClient;
}

const config = loadConfig({
  SCORE_SAME_ESP_ONLY: "true",
  MIN_SAME_ESP_SAMPLES: "3",
  ENABLE_REMEDIATION: "true",
  REMEDIATION_INBOX_THRESHOLD: "80",
  DELIVERABILITY_THRESHOLD: "80",
});

describe("ResultMonitor same-ESP alert scoring", () => {
  it("scores alerts on the same-ESP number remediation acts on", async () => {
    const captured: Captured = {};
    const smartlead = {
      listAllEmailAccounts: async () => [
        { id: 1, from_email: "outlook-sender@brand.com", type: "OUTLOOK" },
      ],
    } as unknown as SmartleadClient;

    const monitor = new ResultMonitor(
      config,
      fakeSmartDelivery(),
      smartlead,
      fakeSlack(captured),
      fakeState(),
    );
    await monitor.run();

    const sender = captured.senders?.[0];
    assert.ok(sender, "expected a sender in the placement alert");
    // Same-ESP (Microsoft seeds only) — all three inboxed.
    assert.equal(sender.inboxPercent, 100);
    assert.equal(sender.scoredSameEsp, true);
    // 100% is above the 80% threshold, so no rotation should be promised.
    assert.equal(sender.willRemediate, false);
  });

  it("falls back to blended scoring when Smartlead types are unavailable", async () => {
    const captured: Captured = {};
    const smartlead = {
      listAllEmailAccounts: async () => {
        throw new Error("smartlead down");
      },
    } as unknown as SmartleadClient;

    const monitor = new ResultMonitor(
      config,
      fakeSmartDelivery(),
      smartlead,
      fakeSlack(captured),
      fakeState(),
    );
    await monitor.run();

    const sender = captured.senders?.[0];
    assert.ok(sender, "alert should still go out when Smartlead is down");
    assert.equal(sender.inboxPercent, 50);
    assert.equal(sender.scoredSameEsp, false);
  });

  it("skips gone SmartDelivery tests without recording an error", async () => {
    const smartlead = {
      listAllEmailAccounts: async () => [],
    } as unknown as SmartleadClient;

    const state = {
      get: () => ({
        testedCampaigns: {
          "1": {
            campaignId: 1,
            campaignName: "gone",
            testedAt: new Date().toISOString(),
            testIds: ["502070"],
            mailboxCount: 1,
            testsCreated: 1,
          },
        },
      }),
      hasAlert: () => false,
      markAlert: () => undefined,
      setLastMonitorAt: () => undefined,
      save: async () => undefined,
    } as unknown as StateStore;

    const smartDelivery = {
      listTests: async () => [],
      getProviderwiseReport: async () => {
        throw new Error("Spam test not found");
      },
      getSenderAccountReport: async () => [],
      getDomainBlacklist: async () => {
        throw new Error("Spam test not found");
      },
      getIpBlacklist: async () => [],
      getMailboxSummary: async () => [],
    } as unknown as SmartDeliveryClient;

    const monitor = new ResultMonitor(
      config,
      smartDelivery,
      smartlead,
      fakeSlack({}),
      state,
    );
    const result = await monitor.run();
    assert.equal(result.errors.length, 0);
    assert.equal(result.testsChecked, 1);
  });

  it("fetches Smartlead account types at most once per run", async () => {
    const captured: Captured = {};
    let calls = 0;
    const smartlead = {
      listAllEmailAccounts: async () => {
        calls += 1;
        return [{ id: 1, from_email: "outlook-sender@brand.com", type: "OUTLOOK" }];
      },
    } as unknown as SmartleadClient;

    const smartDelivery = {
      ...fakeSmartDelivery(),
      listTests: async () => [
        { id: "t1", test_name: "One" },
        { id: "t2", test_name: "Two" },
      ],
    } as unknown as SmartDeliveryClient;

    const monitor = new ResultMonitor(
      config,
      smartDelivery,
      smartlead,
      fakeSlack(captured),
      fakeState(),
    );
    await monitor.run();
    assert.equal(calls, 1);
  });
});
