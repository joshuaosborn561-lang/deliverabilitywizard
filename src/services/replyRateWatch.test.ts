import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { ReplyRateWatchService } from "./replyRateWatch.js";

const campaigns = [
  { id: 1, name: "Live", status: "ACTIVE", client_id: 7 },
  { id: 2, name: "Old", status: "PAUSED", client_id: 7 },
];
const accounts = [
  { id: 10, from_email: "a@good.com", campaign_ids: [1], client_id: 7 },
  { id: 11, from_email: "b@bad.com", campaign_ids: [1], client_id: 7 },
  { id: 12, from_email: "c@bad.com", campaign_ids: [1], client_id: 7 },
  { id: 13, from_email: "p@paused.com", campaign_ids: [2], client_id: 7 },
];

function rows(spec: Array<[string, number, number]>) {
  return { data: spec.map(([from_email, sent_count, reply_count]) => ({ from_email, sent_count, reply_count })) };
}

async function rig(opts: { sevenDay: Array<[string, number, number]>; dryRun?: boolean }) {
  const state = new StateStore(`/tmp/d311-${process.pid}-${Date.now()}-${Math.random()}.json`);
  await state.load();
  const log: string[] = [];
  const slackSent: Array<{ text: string; kind?: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  let call = 0;
  // The Smartlead surface is read-only: any other method is a TypeError.
  const smartlead = {
    getMailboxHealthMetrics: async () => {
      log.push("metrics");
      call += 1;
      return call % 2 === 1
        ? rows(opts.sevenDay)
        : rows([["a@good.com", 800, 16], ["b@bad.com", 600, 12], ["c@bad.com", 600, 12]]);
    },
  };
  const svc = new ReplyRateWatchService({
    smartlead: smartlead as never,
    smartDelivery: {
      resolveProviderIds: async () => [2, 20],
      createManualPlacement: async (payload: Record<string, unknown>) => {
        created.push(payload);
        return { id: "pt-1" };
      },
    } as never,
    slack: {
      send: async (text: string, _b?: unknown, kind?: string) => {
        slackSent.push({ text, kind });
        return undefined;
      },
    } as never,
    state,
    config: loadConfig({ DRY_RUN: "false", SLACK_JOSH_USER_ID: "UJOSH" } as never),
    now: () => new Date("2026-10-29T12:00:00Z"),
  });
  return { svc, state, slackSent, created, log, dryRun: opts.dryRun };
}

describe("D311 reply-rate watch", () => {
  it("alerts Josh first, then runs ONE placement test on that domain's mailboxes only", async () => {
    // baseline (30d): 40 replies / 2000 sends = 2.0%. bad.com 7d: 1/300 = 0.33%.
    const { svc, state, slackSent, created } = await rig({
      sevenDay: [["a@good.com", 300, 6], ["b@bad.com", 150, 1], ["c@bad.com", 150, 0]],
    });
    const result = await svc.run({ campaigns: campaigns as never, accounts: accounts as never, dryRun: false });
    assert.deepEqual(result.flagged.map((f) => f.domain), ["bad.com"]);
    assert.equal(slackSent.length, 1);
    assert.equal(slackSent[0]!.kind, "ops_alert");
    assert.match(slackSent[0]!.text, /<@UJOSH>/);
    assert.match(slackSent[0]!.text, /bad\.com/);
    assert.equal(created.length, 1, "exactly one placement test");
    assert.deepEqual((created[0]!.sender_accounts as string[]).sort(), ["b@bad.com", "c@bad.com"]);
    assert.match(String(created[0]!.test_name), /^Reply drop: bad\.com/);
    assert.equal(state.getReplyDrop("bad.com")?.testId, "pt-1");
    assert.deepEqual(result.tested, [{ domain: "bad.com", testId: "pt-1" }]);
  });

  it("is alert-only: no isolation, no pull, no pause (read-only Smartlead surface)", async () => {
    const { svc, state } = await rig({
      sevenDay: [["b@bad.com", 150, 0], ["c@bad.com", 150, 0]],
    });
    const before = JSON.stringify(state.listMailboxRests());
    const result = await svc.run({ campaigns: campaigns as never, accounts: accounts as never, dryRun: false });
    assert.equal(result.flagged.length, 1);
    assert.equal(result.errors.length, 0, "ran with a Smartlead stub that has only the read method");
    assert.equal(JSON.stringify(state.listMailboxRests()), before, "no rest record opened");
    assert.equal(state.listIsolationActions().length, 0, "no isolation action opened");
  });

  it("under 150 sends in the window does nothing", async () => {
    const { svc, slackSent, created } = await rig({
      sevenDay: [["b@bad.com", 100, 0], ["c@bad.com", 49, 0]],
    });
    const result = await svc.run({ campaigns: campaigns as never, accounts: accounts as never, dryRun: false });
    assert.deepEqual(result.flagged, []);
    assert.equal(slackSent.length + created.length, 0);
  });

  it("does not re-alert or re-test the same domain inside 7 days", async () => {
    const { svc, slackSent, created } = await rig({
      sevenDay: [["b@bad.com", 150, 0], ["c@bad.com", 150, 0]],
    });
    const run = () => svc.run({ campaigns: campaigns as never, accounts: accounts as never, dryRun: false });
    await run();
    await run();
    assert.equal(slackSent.length, 1);
    assert.equal(created.length, 1);
  });

  it("dry run flags but alerts and tests nothing", async () => {
    const { svc, slackSent, created } = await rig({
      sevenDay: [["b@bad.com", 150, 0], ["c@bad.com", 150, 0]],
    });
    const result = await svc.run({ campaigns: campaigns as never, accounts: accounts as never, dryRun: true });
    assert.equal(result.flagged.length, 1);
    assert.equal(slackSent.length + created.length, 0);
  });
});
