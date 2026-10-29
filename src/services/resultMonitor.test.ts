import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { ResultMonitor } from "./resultMonitor.js";

const AIRPODS = {
  id: 3847794,
  name: "TechEvo SFL Startup Owners AirPods",
  status: "ACTIVE",
};

function fakeSmartDelivery(opts: {
  testName?: string;
  campaignId?: number;
  inboxRate?: number;
} = {}): SmartDeliveryClient {
  return {
    listTests: async () => [
      {
        id: "t1",
        test_name: opts.testName ?? `Canary copy: #${AIRPODS.id} ${AIRPODS.name}`,
        campaign_id: opts.campaignId ?? 999001,
      },
    ],
    getProviderwiseReport: async () => ({
      result: [{ provider_name: "Gmail", inbox_rate: opts.inboxRate ?? 0 }],
    }),
    getSenderAccountReport: async () => [],
    getDomainBlacklist: async () => [],
    getIpBlacklist: async () => [],
    getMailboxSummary: async () => [],
    reportReadsPaused: () => false,
    reportParallelism: () => 1,
  } as unknown as SmartDeliveryClient;
}

function fakeSlack(
  pages: string[] = [],
  blacklistPages: string[] = [],
): SlackClient {
  return {
    send: async () => undefined,
    notifyPlacementResult: async (details: { testName?: string }) => {
      pages.push(details.testName ?? "placement");
    },
    notifyBlacklist: async () => undefined,
    notifyBlacklistDiagnosis: async (details: {
      diagnoses: Array<{ domain: string }>;
    }) => {
      blacklistPages.push(...details.diagnoses.map((d) => d.domain));
    },
    notifyLowDeliverability: async () => undefined,
  } as unknown as SlackClient;
}

const config = loadConfig({
  SCORE_SAME_ESP_ONLY: "true",
  MIN_SAME_ESP_SAMPLES: "3",
  REMEDIATION_INBOX_THRESHOLD: "80",
  DELIVERABILITY_THRESHOLD: "80",
});

describe("ResultMonitor queues isolation from ugly same-ESP (D158)", () => {
  it("canary-copy under 80% marks the ACTIVE live campaign as a copy suspect", async () => {
    const state = new StateStore(
      `/tmp/dw-monitor-canary-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const smartlead = {
      listCampaigns: async () => [
        AIRPODS,
        { id: 999001, name: "Canary shell: #3847794 AirPods", status: "PAUSED" },
      ],
    } as unknown as SmartleadClient;

    const pages: string[] = [];
    const monitor = new ResultMonitor(
      config,
      fakeSmartDelivery(),
      smartlead,
      fakeSlack(pages),
      state,
    );
    const result = await monitor.run();

    const suspect = state.listCopySuspects()[0];
    assert.ok(suspect, "expected a copy suspect");
    assert.equal(pages.length, 1, "first same-ESP under 80% pages Slack");
    assert.equal(suspect.campaignId, AIRPODS.id);
    assert.match(String(suspect.reason), /Canary-copy same-ESP/);
    assert.equal(result.lowDeliverabilityAlerts, 1);
    assert.equal(result.errors.length, 0);
  });

  it("does not re-queue when a covering COPY/INFRA run already owns the campaign", async () => {
    const state = new StateStore(
      `/tmp/dw-monitor-once-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markCopySuspect({
      campaignId: AIRPODS.id,
      campaignName: AIRPODS.name,
      at: "2026-09-01T18:00:00.000Z",
      evaluatedAt: "2026-09-01T18:05:00.000Z",
      reason: "already done",
    });
    state.upsertIsolationRun({
      id: "copy-run",
      campaignId: AIRPODS.id,
      campaignName: AIRPODS.name,
      startedAt: "2026-09-01T18:05:00.000Z",
      updatedAt: "2026-09-01T18:05:00.000Z",
      control: "CLEAN",
      verdict: "COPY",
      campaignInSpam: true,
      reason: "copy",
      teardownStarted: true,
    });
    const smartlead = {
      listCampaigns: async () => [AIRPODS],
    } as unknown as SmartleadClient;

    const monitor = new ResultMonitor(
      config,
      fakeSmartDelivery(),
      smartlead,
      fakeSlack(),
      state,
    );
    const result = await monitor.run();
    assert.equal(result.lowDeliverabilityAlerts, 0);
    assert.equal(state.listCopySuspects().length, 1);
    assert.ok(state.listCopySuspects()[0]?.evaluatedAt);
  });

  it("re-queues when evaluatedAt is set but the latest run is INCONCLUSIVE (D164)", async () => {
    const state = new StateStore(
      `/tmp/dw-monitor-requeue-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markCopySuspect({
      campaignId: AIRPODS.id,
      campaignName: AIRPODS.name,
      at: "2026-08-26T12:00:00.000Z",
      evaluatedAt: "2026-08-26T12:05:00.000Z",
      reason: "old COPY",
    });
    state.upsertIsolationRun({
      id: "old-copy",
      campaignId: AIRPODS.id,
      campaignName: AIRPODS.name,
      startedAt: "2026-08-26T12:05:00.000Z",
      updatedAt: "2026-08-26T12:05:00.000Z",
      control: "CLEAN",
      verdict: "COPY",
      campaignInSpam: true,
      reason: "copy",
      teardownStarted: true,
    });
    state.upsertIsolationRun({
      id: "later-inconclusive",
      campaignId: AIRPODS.id,
      campaignName: AIRPODS.name,
      startedAt: "2026-08-28T18:00:00.000Z",
      updatedAt: "2026-08-28T18:00:00.000Z",
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason: "need another reading",
    });
    const smartlead = {
      listCampaigns: async () => [AIRPODS],
    } as unknown as SmartleadClient;

    const monitor = new ResultMonitor(
      config,
      fakeSmartDelivery(),
      smartlead,
      fakeSlack(),
      state,
    );
    const result = await monitor.run();
    assert.equal(result.lowDeliverabilityAlerts, 1);
    const suspect = state.listCopySuspects()[0];
    assert.equal(suspect?.evaluatedAt, undefined);
  });

  it("does not re-queue INCONCLUSIVE on a COMPLETED campaign (D165)", async () => {
    const completed = {
      id: 3763805,
      name: "BCP Logistics Over-1k (With Team)",
      status: "COMPLETED",
    };
    const state = new StateStore(
      `/tmp/dw-monitor-completed-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markCopySuspect({
      campaignId: completed.id,
      campaignName: completed.name,
      at: "2026-08-24T12:00:00.000Z",
      evaluatedAt: "2026-08-24T12:05:00.000Z",
      reason: "stale inconclusive",
    });
    state.upsertIsolationRun({
      id: "stale-aug-24",
      campaignId: completed.id,
      campaignName: completed.name,
      startedAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:00.000Z",
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason:
        "No standing inbox-test reading for the mailboxes this campaign is sending from.",
    });
    const smartlead = {
      listCampaigns: async () => [completed],
    } as unknown as SmartleadClient;

    const monitor = new ResultMonitor(
      config,
      fakeSmartDelivery({
        testName: `Canary copy: #${completed.id} ${completed.name}`,
      }),
      smartlead,
      fakeSlack(),
      state,
    );
    const result = await monitor.run();
    assert.equal(result.lowDeliverabilityAlerts, 0);
    assert.equal(
      state.listCopySuspects()[0]?.evaluatedAt,
      "2026-08-24T12:05:00.000Z",
      "COMPLETED must not D164 re-queue",
    );
  });

  it("skips shells and isolation-managed tests as the target", async () => {
    const state = new StateStore(
      `/tmp/dw-monitor-skip-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const smartlead = {
      listCampaigns: async () => [AIRPODS],
    } as unknown as SmartleadClient;
    const monitor = new ResultMonitor(
      config,
      fakeSmartDelivery({
        testName: "Pod control: TechEvo A",
        campaignId: AIRPODS.id,
        inboxRate: 0,
      }),
      smartlead,
      fakeSlack(),
      state,
    );
    await monitor.run();
    assert.equal(state.listCopySuspects().length, 0);
  });

  it("scores copyCanaries test ids even when they are absent from testedCampaigns and listTests", async () => {
    const state = new StateStore(
      `/tmp/dw-monitor-canary-state-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.setCopyCanaries(AIRPODS.id, ["canary@g.test"], "526826");
    const fetched: string[] = [];
    const clutter = Array.from({ length: 120 }, (_, i) => ({
      id: String(400000 + i),
      test_name: `Old manual ${i}`,
      status: "COMPLETED",
      test_type: "manual",
    }));
    const smartDelivery = {
      listTests: async () => clutter,
      getProviderwiseReport: async (id: string) => {
        fetched.push(String(id));
        return {
          result: [
            {
              provider_name: "Gmail",
              inbox_rate: String(id) === "526826" ? 0 : 100,
            },
          ],
        };
      },
      getSenderAccountReport: async () => [],
      getDomainBlacklist: async () => [],
      getIpBlacklist: async () => [],
      getMailboxSummary: async () => [],
      reportReadsPaused: () => false,
      reportParallelism: () => 1,
    } as unknown as SmartDeliveryClient;

    const monitor = new ResultMonitor(
      config,
      smartDelivery,
      { listCampaigns: async () => [AIRPODS] } as unknown as SmartleadClient,
      fakeSlack(),
      state,
    );
    const result = await monitor.run();
    assert.ok(fetched.includes("526826"), "copy-canary id must be fetched");
    const suspect = state.listCopySuspects().find((row) => row.campaignId === AIRPODS.id);
    assert.ok(suspect, "0% canary under copyCanaries must queue isolation");
    assert.match(String(suspect.reason), /Canary-copy same-ESP/);
    assert.equal(result.lowDeliverabilityAlerts, 1);
  });

  it("skips gone SmartDelivery tests without recording an error", async () => {
    const state = new StateStore(
      `/tmp/dw-monitor-gone-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markCampaignTested({
      campaignId: 1,
      campaignName: "gone",
      testedAt: new Date().toISOString(),
      testIds: ["502070"],
      mailboxCount: 1,
      testsCreated: 1,
    });

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
      reportReadsPaused: () => false,
      reportParallelism: () => 1,
    } as unknown as SmartDeliveryClient;

    const monitor = new ResultMonitor(
      config,
      smartDelivery,
      { listCampaigns: async () => [] } as unknown as SmartleadClient,
      fakeSlack(),
      state,
    );
    const result = await monitor.run();
    assert.equal(result.errors.length, 0);
    assert.equal(result.testsChecked, 1);
  });

  it("does not alert, retire, or teardown on a SURBL-only listing (D210)", async () => {
    const state = new StateStore(
      `/tmp/dw-monitor-surbl-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markCampaignTested({
      campaignId: AIRPODS.id,
      campaignName: AIRPODS.name,
      testedAt: new Date().toISOString(),
      testIds: ["surbl-only"],
      mailboxCount: 1,
      testsCreated: 1,
    });
    const blacklistPages: string[] = [];
    const smartDelivery = {
      listTests: async () => [{ id: "surbl-only", test_name: "live" }],
      getProviderwiseReport: async () => ({
        result: [{ provider_name: "Gmail", inbox_rate: 100 }],
      }),
      getSenderAccountReport: async () => [],
      getDomainBlacklist: async () => [
        {
          from_email: "a@salesgliderhub.com",
          domain_blacklisted: true,
          seed_accounts: [
            { email: "seed@gmail.com", esp: "Gmail", domain_blacklisted: true },
          ],
        },
      ],
      getIpBlacklist: async () => [
        {
          reply: { from_email: "a@salesgliderhub.com" },
          blacklist_type_value: "multi.surbl.org",
          total_blacklist: 1,
          ip: "1.2.3.4",
          details: "127.0.0.64",
        },
      ],
      getMailboxSummary: async () => [],
      reportReadsPaused: () => false,
      reportParallelism: () => 1,
    } as unknown as SmartDeliveryClient;

    const monitor = new ResultMonitor(
      config,
      smartDelivery,
      { listCampaigns: async () => [AIRPODS] } as unknown as SmartleadClient,
      fakeSlack([], blacklistPages),
      state,
    );
    const result = await monitor.run();
    assert.equal(result.blacklistAlerts, 0);
    assert.deepEqual(blacklistPages, []);
    assert.equal(result.errors.length, 0);
  });
});

describe("ResultMonitor D319 budget and carry-over", () => {
  function many(n: number, over: Record<string, unknown> = {}): SmartDeliveryClient {
    return {
      listTests: async () =>
        Array.from({ length: n }, (_, i) => ({ id: `t${i}`, test_name: `Auto: x${i}`, campaign_id: 1 })),
      getProviderwiseReport: async () => ({ result: [] }),
      getSenderAccountReport: async () => [],
      getDomainBlacklist: async () => [],
      getIpBlacklist: async () => [],
      getMailboxSummary: async () => [],
      reportReadsPaused: () => false,
      reportParallelism: () => 1,
      ...over,
    } as unknown as SmartDeliveryClient;
  }
  const smartlead = { listCampaigns: async () => [] } as unknown as SmartleadClient;

  it("stops when the 429 breaker opens, carries the rest, and resumes there next pass", async () => {
    const state = new StateStore("/tmp/d319-monitor-state-" + Date.now() + ".json");
    await state.load();
    let paused = false;
    let tripped = false;
    const seen: string[] = [];
    const sd = many(10, {
      reportReadsPaused: () => paused,
      getProviderwiseReport: async (id: string) => {
        seen.push(id);
        if (seen.length === 4 && !tripped) {
          tripped = true;
          paused = true;
        }
        return { result: [] };
      },
    });
    const monitor = new ResultMonitor(config, sd, smartlead, fakeSlack(), state);
    const first = await monitor.run();
    assert.equal(first.testsChecked, 4);
    assert.equal(first.carriedOver, 6);
    paused = false;
    seen.length = 0;
    const second = await monitor.run();
    assert.equal(second.carriedOver, 0);
    assert.equal(second.testsChecked, 10);
    assert.equal(seen[0], "t4", "next pass did not resume where the last stopped");
  });

  it("a bounced (paused) test is carried over, not recorded as an error", async () => {
    const state = new StateStore("/tmp/d319-monitor-state-b-" + Date.now() + ".json");
    await state.load();
    const { ReportReadsPausedError } = await import("../clients/smartdelivery.js");
    const sd = many(3, {
      getProviderwiseReport: async (id: string) => {
        if (id === "t1") throw new ReportReadsPausedError(Date.now() + 60_000);
        return { result: [] };
      },
    });
    const monitor = new ResultMonitor(config, sd, smartlead, fakeSlack(), state);
    const out = await monitor.run();
    assert.equal(out.carriedOver, 1);
    assert.equal(out.errors.filter((e) => e.startsWith("test ")).length, 0);
  });

  it("an exhausted time budget carries the unstarted tests", async () => {
    const state = new StateStore("/tmp/d319-monitor-state-c-" + Date.now() + ".json");
    await state.load();
    const sd = many(5, {
      getProviderwiseReport: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return { result: [] };
      },
    });
    const monitor = new ResultMonitor(config, sd, smartlead, fakeSlack(), state, 20);
    const out = await monitor.run();
    assert.ok((out.carriedOver ?? 0) > 0 && (out.carriedOver ?? 0) < 5);
  });
});
