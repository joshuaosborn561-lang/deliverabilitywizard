import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SmartleadClient } from "../clients/smartlead.js";
import { loadMailboxHealthConfig } from "../lib/mailboxHealthDaily.js";
import { MailboxHealthStore } from "../state/mailboxHealthStore.js";
import { StateStore } from "../state/store.js";
import { MailboxHealthDailyService } from "./mailboxHealthDaily.js";

const NOW = new Date("2026-11-11T13:15:00Z"); // 7:15am CST → snapshot 2026-11-10
const campaigns = [
  { id: 1, name: "Live", status: "ACTIVE" },
  { id: 2, name: "Stopped", status: "STOPPED" },
];
const accounts = [
  { id: 10, from_email: "jo@acme.com", type: "GMAIL", campaign_ids: [1], client_id: 345263, owner_slug: "salesglider", tags: [{ tag_name: "POD-B" }], warmup_details: { warmup_reputation: "85%" } },
  { id: 11, from_email: "ok@beta.io", type: "OUTLOOK", campaign_ids: [1], client_id: null, warmup_details: { warmup_reputation: "100%" } },
  { id: 12, from_email: "off@gamma.co", type: "GMAIL", campaign_ids: [2], warmup_details: { warmup_reputation: "40%" } },
];

/**
 * Every SmartleadClient method stubbed to record its name — so a call to
 * any write (updateCampaignStatus, removeEmailAccountsFromCampaign,
 * updateEmailAccount, …) would show up here.
 */
function recordingSmartlead(payload: unknown) {
  const calls: string[] = [];
  const fake: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(SmartleadClient.prototype)) {
    if (name === "constructor") continue;
    fake[name] = async () => {
      calls.push(name);
      return name === "getMailboxHealthMetrics" ? payload : undefined;
    };
  }
  return { fake, calls };
}

async function rig(opts: { payload?: unknown; env?: NodeJS.ProcessEnv; dryRun?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "d334-"));
  const state = new StateStore(path.join(dir, "state.json"));
  await state.load();
  const store = MailboxHealthStore.forStateFile(path.join(dir, "state.json"));
  const slackSent: Array<{ text: string; kind?: string }> = [];
  const { fake, calls } = recordingSmartlead(
    opts.payload ?? {
      data: [
        { from_email: "jo@acme.com", sent_count: 40, reply_count: 1, bounce_count: 2 },
        { from_email: "ok@beta.io", sent_count: 40, reply_count: 1, bounce_count: 0 },
      ],
    },
  );
  const svc = new MailboxHealthDailyService({
    smartlead: fake as never,
    slack: {
      send: async (text: string, _b?: unknown, kind?: string) => {
        slackSent.push({ text, kind });
        return undefined;
      },
    } as never,
    state,
    store,
    config: loadMailboxHealthConfig(opts.env ?? {}),
    dryRun: opts.dryRun,
    now: () => NOW,
  });
  return { dir, svc, store, state, slackSent, calls };
}

describe("D334 mailbox health daily — service", () => {
  it("snapshots ACTIVE mailboxes keyed by mailbox+date; re-run overwrites", async () => {
    const r = await rig();
    const res = await r.svc.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.equal(res.date, "2026-11-10");
    assert.equal(res.mailboxes, 2);
    assert.deepEqual(await readdir(path.join(r.dir, "mailbox-health")), ["2026-11-10.json"]);
    const day = await r.store.read("2026-11-10");
    assert.deepEqual(Object.keys(day!.rows).sort(), ["jo@acme.com", "ok@beta.io"]);
    const jo = day!.rows["jo@acme.com"]!;
    assert.equal(jo.date, "2026-11-10");
    assert.equal(jo.bounceRate, 5);
    assert.equal(jo.replyRate, 2.5);
    assert.equal(jo.warmupScore, 85);
    assert.equal(jo.pod, "B");
    assert.equal(jo.owner, "salesglider");
    assert.equal(jo.esp, "GOOGLE");
    assert.equal(day!.rows["ok@beta.io"]!.esp, "MICROSOFT");

    // Same date again with different numbers: one file, overwritten.
    const r2 = new MailboxHealthDailyService({
      smartlead: recordingSmartlead({ data: [{ from_email: "jo@acme.com", sent_count: 10, reply_count: 0, bounce_count: 0 }] }).fake as never,
      slack: { send: async () => undefined } as never,
      state: r.state,
      store: r.store,
      config: loadMailboxHealthConfig({}),
      now: () => NOW,
    });
    await r2.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.deepEqual(await readdir(path.join(r.dir, "mailbox-health")), ["2026-11-10.json"]);
    assert.equal((await r.store.read("2026-11-10"))!.rows["jo@acme.com"]!.sent, 10);
    assert.equal((await r.store.read("2026-11-10"))!.rows["ok@beta.io"]!.sent, null);
  });

  it("calls only getMailboxHealthMetrics on Smartlead — no pause/stop/unpause/rest/burn/swap/edit", async () => {
    const r = await rig();
    const res = await r.svc.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.ok(res.trends.length > 0, "fixture must flag so the alert path runs");
    assert.deepEqual(r.calls, ["getMailboxHealthMetrics"]);
  });

  it("flags → one Slack ops_alert, deduped per mailbox per flag per day; /health findings", async () => {
    const r = await rig();
    const first = await r.svc.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.deepEqual(first.trends.map((t) => `${t.email}:${t.flag}`), ["jo@acme.com:warmup_low"]);
    assert.equal(r.slackSent.length, 1);
    assert.equal(r.slackSent[0]!.kind, "ops_alert");
    assert.match(r.slackSent[0]!.text, /jo@acme\.com \(salesglider · POD-B\) — \*warmup_low\*/);
    assert.match(r.slackSent[0]!.text, /alert only/);
    const open = r.svc.openFindings();
    assert.equal(open.date, "2026-11-10");
    assert.deepEqual(open.findings.map((f) => f.split(" — ")[0]), ["mailbox_health_trend: jo@acme.com warmup_low"]);

    const again = await r.svc.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.equal(again.trends.length, 1);
    assert.equal(again.alerted, 0);
    assert.equal(r.slackSent.length, 1, "second run the same day does not re-post");
  });

  it("alerts flag off: snapshot + findings still recorded, no Slack", async () => {
    const r = await rig({ env: { MAILBOX_HEALTH_ALERTS_ENABLED: "false" } });
    const res = await r.svc.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.equal(res.trends.length, 1);
    assert.equal(r.slackSent.length, 0);
  });

  it("daily flag off: nothing read, nothing written", async () => {
    const r = await rig({ env: { MAILBOX_HEALTH_DAILY_ENABLED: "false" } });
    const res = await r.svc.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.equal(res.date, null);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(await readdir(r.dir).then((f) => f.filter((x) => x === "mailbox-health")), []);
  });

  it("never runs 20:00–05:59 CT even when invoked", async () => {
    const r = await rig();
    const late = new MailboxHealthDailyService({
      smartlead: recordingSmartlead({}).fake as never,
      slack: { send: async () => undefined } as never,
      state: r.state,
      store: r.store,
      config: loadMailboxHealthConfig({}),
      now: () => new Date("2026-11-12T03:30:00Z"), // 21:30 CST
    });
    const res = await late.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.equal(res.date, null);
    assert.match(res.skipped.join(), /outside 06:00/);
  });

  it("retention: snapshots older than 120 days are pruned; loadOpenFindings restores after restart", async () => {
    const r = await rig();
    const dir = path.join(r.dir, "mailbox-health");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    for (const d of ["2026-07-12", "2026-07-13"]) {
      await writeFile(path.join(dir, `${d}.json`), JSON.stringify({ date: d, generatedAt: "", rows: {}, trends: [] }));
    }
    const res = await r.svc.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.equal(res.pruned, 1);
    assert.deepEqual((await readdir(dir)).sort(), ["2026-07-13.json", "2026-11-10.json"]);
    const stored = JSON.parse(await readFile(path.join(dir, "2026-11-10.json"), "utf8"));
    assert.equal(stored.trends.length, 1);

    const fresh = new MailboxHealthDailyService({
      smartlead: recordingSmartlead({}).fake as never,
      slack: { send: async () => undefined } as never,
      state: r.state,
      store: r.store,
      config: loadMailboxHealthConfig({}),
    });
    await fresh.loadOpenFindings();
    assert.equal(fresh.openFindings().findings.length, 1);
  });

  it("metrics read fails: warmup still snapshots, counts stay null (not zero)", async () => {
    const r = await rig();
    const failing = recordingSmartlead(null);
    (failing.fake as Record<string, unknown>).getMailboxHealthMetrics = async () => {
      throw new Error("HTTP 429");
    };
    const svc = new MailboxHealthDailyService({
      smartlead: failing.fake as never,
      slack: { send: async () => undefined } as never,
      state: r.state,
      store: r.store,
      config: loadMailboxHealthConfig({}),
      now: () => NOW,
    });
    const res = await svc.run({ campaigns: campaigns as never, accounts: accounts as never });
    assert.equal(res.errors.length, 1);
    const day = await r.store.read("2026-11-10");
    assert.equal(day!.metricsMissing, true);
    assert.equal(day!.rows["jo@acme.com"]!.sent, null);
    assert.equal(day!.rows["jo@acme.com"]!.warmupScore, 85);
  });
});
