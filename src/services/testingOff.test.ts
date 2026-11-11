/**
 * D333 — with DELIVERABILITY_TESTING_ENABLED unset, every testing entry
 * point is a no-op that makes zero Smartlead / SmartDelivery calls, the
 * testing findings are never emitted and clear from stored rows, and the
 * launch gate passes without a placement reading.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  DeliverabilityTestingOffError,
  SmartDeliveryClient as RealSmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { DELIVERABILITY_TESTING_ENV } from "../lib/deliverabilityTesting.js";
import { StateStore } from "../state/store.js";
import { CampaignCheckService } from "./campaignCheck.js";
import { CampaignScanner } from "./campaignScanner.js";
import { CopyCanaryService } from "./copyCanary.js";
import { CopyCanaryBuyService } from "./copyCanaryBuy.js";
import { CopyIsolationService } from "./copyIsolation.js";
import type { InventoryBook } from "./inventory.js";
import { IsolationBranchService } from "./isolationBranch.js";
import { IsolationRigService } from "./isolationRig.js";
import { PodControlService } from "./podControls.js";
import { ReplyRateWatchService } from "./replyRateWatch.js";
import { ResultMonitor } from "./resultMonitor.js";
import { UnpauseAfterSigQaService } from "./unpauseAfterSigQa.js";

delete process.env[DELIVERABILITY_TESTING_ENV];

/** Any method call on this object is recorded and throws. */
function tripwire(name: string, calls: string[]): never {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        return (..._args: unknown[]) => {
          calls.push(`${name}.${String(prop)}`);
          throw new Error(`unexpected call ${name}.${String(prop)} with testing off`);
        };
      },
    },
  ) as never;
}

function stateFile(): string {
  return `/tmp/testing-off-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

const config = () => loadConfig({ DRY_RUN: "false" });

describe("D333 testing off — entry points make no Smartlead calls", () => {
  it("scanner (Auto: campaign placement / backfill) is a no-op", async () => {
    const calls: string[] = [];
    const result = await new CampaignScanner(
      config(),
      tripwire("smartlead", calls),
      tripwire("smartDelivery", calls),
      tripwire("slack", calls),
      tripwire("state", calls),
    ).run({ trigger: "canon-sweep" });
    assert.deepEqual(calls, []);
    assert.equal(result.created, 0);
    assert.deepEqual(result.createdTestIds, []);
  });

  it("pod-control known-good tests are a no-op", async () => {
    const calls: string[] = [];
    const result = await new PodControlService(
      config(),
      tripwire("smartlead", calls),
      tripwire("smartDelivery", calls),
      tripwire("slack", calls),
      tripwire("state", calls),
      tripwire("book", calls),
    ).run();
    assert.deepEqual(calls, []);
    assert.deepEqual(result.testsCreated, []);
  });

  it("Canary shell / Canary copy / variant copy tests are a no-op", async () => {
    const calls: string[] = [];
    const service = new CopyCanaryService(
      config(),
      tripwire("smartlead", calls),
      tripwire("smartDelivery", calls),
      tripwire("slack", calls),
      tripwire("state", calls),
    );
    const attach = await service.attach();
    assert.equal(attach.testsEnsured, 0);
    const variants = await service.ensureVariantCopyTests(
      { id: 1, name: "Live", status: "ACTIVE" } as never,
      [],
      [],
      false,
      [],
      [],
    );
    assert.equal(variants, 0);
    assert.deepEqual(calls, []);
  });

  it("canary-adopt and canary-buy-resume are a no-op", async () => {
    const calls: string[] = [];
    const service = new CopyCanaryBuyService(
      config(),
      tripwire("inboxkit", calls),
      tripwire("porkbun", calls),
      tripwire("smartlead", calls),
      tripwire("state", calls),
      tripwire("spend", calls),
    );
    assert.equal(await service.adoptManualPurchase(), null);
    assert.equal(await service.resume(), 0);
    assert.deepEqual(calls, []);
  });

  it("monitor-results (placement polling, pause / swap / score) is a no-op", async () => {
    const calls: string[] = [];
    const result = await new ResultMonitor(
      config(),
      tripwire("smartDelivery", calls),
      tripwire("smartlead", calls),
      tripwire("slack", calls),
      tripwire("state", calls),
    ).run();
    assert.deepEqual(calls, []);
    assert.equal(result.testsChecked, 0);
    assert.equal(result.lowDeliverabilityAlerts, 0);
  });

  it("isolation rig / copy isolation / isolation branch create no tests", async () => {
    const calls: string[] = [];
    const rig = new IsolationRigService(
      config(),
      tripwire("smartlead", calls),
      tripwire("smartDelivery", calls),
      tripwire("slack", calls),
      tripwire("state", calls),
    );
    await rig.run();
    const copyIsolation = new CopyIsolationService(
      config(),
      tripwire("smartlead", calls),
      tripwire("smartDelivery", calls),
      tripwire("slack", calls),
      tripwire("state", calls),
      rig,
    );
    const copy = await copyIsolation.runForCampaign({ id: "r1", campaignId: 1 } as never);
    assert.equal(copy.started, false);
    await new IsolationBranchService(
      config(),
      tripwire("smartlead", calls),
      tripwire("smartDelivery", calls),
      tripwire("slack", calls),
      tripwire("state", calls),
      copyIsolation,
      rig,
    ).run();
    assert.deepEqual(calls, []);
  });

  it("reply-rate drop still alerts Josh but creates no placement test", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const slackSent: string[] = [];
    const calls: string[] = [];
    let call = 0;
    const rows = (spec: Array<[string, number, number]>) => ({
      data: spec.map(([from_email, sent_count, reply_count]) => ({
        from_email,
        sent_count,
        reply_count,
      })),
    });
    const svc = new ReplyRateWatchService({
      smartlead: {
        getMailboxHealthMetrics: async () => {
          call += 1;
          return call % 2 === 1
            ? rows([["b@bad.com", 150, 0], ["c@bad.com", 150, 0]])
            : rows([["a@good.com", 800, 16], ["b@bad.com", 600, 12], ["c@bad.com", 600, 12]]);
        },
      } as never,
      smartDelivery: tripwire("smartDelivery", calls),
      slack: {
        send: async (text: string) => {
          slackSent.push(text);
          return undefined;
        },
      } as never,
      state,
      config: loadConfig({ DRY_RUN: "false", SLACK_JOSH_USER_ID: "UJOSH" } as never),
      now: () => new Date("2026-10-29T12:00:00Z"),
    });
    const result = await svc.run({
      campaigns: [{ id: 1, name: "Live", status: "ACTIVE", client_id: 7 }] as never,
      accounts: [
        { id: 10, from_email: "a@good.com", campaign_ids: [1], client_id: 7 },
        { id: 11, from_email: "b@bad.com", campaign_ids: [1], client_id: 7 },
        { id: 12, from_email: "c@bad.com", campaign_ids: [1], client_id: 7 },
      ] as never,
      dryRun: false,
    });
    assert.equal(result.flagged.length, 1);
    assert.equal(slackSent.length, 1, "the alert itself is not testing and stays");
    assert.deepEqual(result.tested, []);
    assert.deepEqual(calls, []);
  });

  it("SmartDelivery create endpoints refuse before any HTTP request", async () => {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      throw new Error("network must not be reached");
    }) as typeof fetch;
    try {
      const client = new RealSmartDeliveryClient("test-key");
      await assert.rejects(
        client.createManualPlacement({} as never),
        DeliverabilityTestingOffError,
      );
      await assert.rejects(
        client.createAutomatedPlacement({} as never),
        DeliverabilityTestingOffError,
      );
      assert.equal(fetched, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("D333 testing off — findings and launch gate", () => {
  const goliath = { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" };

  it("campaign-check never emits missing_canary / no_placement_test and clears stored ones", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    // A dead canary fleet would have been a fleet-level fact; with testing off it clears.
    state.setCanaryFleetDown({ since: "2026-08-20T00:00:00.000Z", fleetSize: 1 });
    state.upsertCampaignCheck({
      campaignId: 1,
      name: "Goliath A",
      firstSeenAt: "2026-11-01T00:00:00.000Z",
      firstCheckAt: "2026-11-01T00:00:00.000Z",
      firstPassedAt: "2026-11-01T00:05:00.000Z",
      lastSweepAt: "2026-11-01T01:00:00.000Z",
      lastKind: "hourly",
      findings: [
        "no_placement_test: no recurring SmartDelivery test for serving inboxes",
        "missing_canary: campaign copy is not on the unwarmed senders canary (Canary copy test)",
        "inbox_missing_known_good: 1 serving inbox(es) not on a known-good copy canary",
      ],
    });
    const sl = {
      listCampaigns: async () => [
        { id: 1, name: "Goliath A", status: "ACTIVE", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 9,
          from_email: "aarav@getoutreachdesk.info",
          from_name: "Aarav Sanchez",
          signature: "Aarav Sanchez\nGoliath Cybersecurity",
          client_id: 548611,
          campaign_ids: [1],
          is_smtp_success: true,
          is_imap_success: true,
        },
      ],
      listClients: async () => [goliath],
      getCampaignSequences: async () => [
        { seq_number: 1, email_body: "<div>Hi</div><div>%signature%</div>" },
      ],
    } as unknown as SmartleadClient;
    const book = {
      get: async () => ({
        campaigns: await sl.listCampaigns(),
        accounts: await (sl as unknown as { listAllEmailAccounts: () => Promise<unknown[]> }).listAllEmailAccounts(),
        clients: await (sl as unknown as { listClients: () => Promise<unknown[]> }).listClients(),
        fetchedAt: Date.now(),
      }),
    } as unknown as InventoryBook;
    const sd = {
      // No tests at all: with testing on this is no_placement_test + missing_canary.
      listTests: async () => [],
      enrichCampaignIds: async (rows: unknown[]) => rows,
    } as unknown as SmartDeliveryClient;
    const service = new CampaignCheckService(loadConfig({}), sl, sd, state, book);

    const hourly = await service.run({ mode: "hourly" });
    const testingKinds = ["no_placement_test", "missing_canary", "inbox_missing_known_good"];
    for (const row of hourly.findings) {
      for (const finding of row.findings) {
        assert.ok(!testingKinds.includes(finding.kind), `emitted ${finding.kind}`);
      }
    }
    const stored = state.getCampaignCheck(1)?.findings ?? [];
    for (const finding of stored) {
      assert.ok(
        !testingKinds.some((kind) => finding.startsWith(kind)),
        `stored ${finding} was not cleared`,
      );
    }
    assert.equal(state.getCanaryFleetDown(), null, "canary fleet-down clears");
  });

  it("qa-unpause STARTs a clean POC campaign with no placement reading", async () => {
    const statuses: Array<[number, string]> = [];
    const calls: string[] = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Goliath Displacement M", status: "PAUSED", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "aaravsanchez@getoutreachdesk.info",
          from_name: "Aarav Sanchez",
          signature: "Aarav Sanchez\nGoliath Cybersecurity",
          client_id: 548611,
          campaign_ids: [1],
        },
      ],
      listClients: async () => [goliath],
      updateCampaignStatus: async (id: number, status: string) => {
        statuses.push([id, status]);
      },
    } as unknown as SmartleadClient;
    const service = new UnpauseAfterSigQaService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      tripwire("smartDelivery", calls),
      { isBouncePaused: () => false } as never,
    );
    const result = await service.run({
      dryRun: false,
      now: new Date("2026-10-16T15:00:00Z"),
    });
    assert.deepEqual(calls, [], "no placement list read");
    assert.deepEqual(statuses, [[1, "START"]]);
    assert.ok(!result.blocked.some((row) => /placement|launch bar/.test(row)));
  });
});
