import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { MailboxHealthRow } from "../lib/mailboxHealthDaily.js";
import { loadWeeklyHealthConfig } from "../lib/mailboxHealthWeekly.js";
import { MailboxHealthStore } from "../state/mailboxHealthStore.js";
import { StateStore } from "../state/store.js";
import { MailboxHealthWeeklyService } from "./mailboxHealthWeekly.js";

const MONDAY_830 = new Date("2026-11-09T14:30:00Z"); // Mon 8:30am CST

function row(date: string, email: string, over: Partial<MailboxHealthRow> = {}): MailboxHealthRow {
  return {
    date, email, domain: email.split("@")[1]!, emailAccountId: 1, esp: "GOOGLE", pod: "A",
    owner: "acme", ownerClientId: 1, sent: 50, replies: 1, bounces: 0, replyRate: 2,
    bounceRate: 0, warmupScore: 99, ...over,
  };
}

async function rig(opts: { env?: NodeJS.ProcessEnv; now?: Date; dryRun?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "d335-"));
  const state = new StateStore(path.join(dir, "state.json"));
  await state.load();
  const store = MailboxHealthStore.forStateFile(path.join(dir, "state.json"));
  for (const date of ["2026-10-27", "2026-11-02", "2026-11-08"]) {
    await store.write({
      date,
      generatedAt: `${date}T13:15:00Z`,
      rows: { "a@one.com": row(date, "a@one.com"), "b@two.io": row(date, "b@two.io", { pod: "B", bounces: 5 }) },
      trends: date === "2026-11-08"
        ? [{ date, email: "b@two.io", domain: "two.io", owner: "acme", pod: "B", flag: "bounce_rate_high", detail: "10%" }]
        : [],
    });
  }
  const sent: Array<{ text: string; kind?: string }> = [];
  const svc = new MailboxHealthWeeklyService({
    slack: { send: async (text: string, _b?: unknown, kind?: string) => { sent.push({ text, kind }); return undefined; } } as never,
    state,
    store,
    config: loadWeeklyHealthConfig(opts.env ?? {}),
    dryRun: opts.dryRun,
    now: () => opts.now ?? MONDAY_830,
  });
  return { svc, sent, state };
}

describe("D335 weekly mailbox health — service", () => {
  it("posts the last completed week once to the report lane (eod_summary)", async () => {
    const r = await rig();
    const res = await r.svc.run();
    assert.equal(res.week, "2026-11-02");
    assert.equal(res.posted, true);
    assert.equal(res.inboxes, 2);
    assert.equal(res.flaggedInboxes, 1);
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0]!.kind, "eod_summary");
    assert.match(r.sent[0]!.text, /b@two\.io \(acme · POD-B\) bounce_rate_high/);
    const again = await r.svc.run();
    assert.equal(again.posted, false);
    assert.match(again.skipped.join(), /already posted 2026-11-02/);
    assert.equal(r.sent.length, 1);
  });

  it("refuses 20:00–05:59 CT and honours the flag and dry run", async () => {
    const night = await rig({ now: new Date("2026-11-10T03:00:00Z") }); // Mon 9pm CST
    assert.match((await night.svc.run()).skipped.join(), /outside 06:00–19:59/);
    const off = await rig({ env: { WEEKLY_HEALTH_REPORT_ENABLED: "false" } });
    assert.match((await off.svc.run()).skipped.join(), /WEEKLY_HEALTH_REPORT_ENABLED is off/);
    const dry = await rig({ dryRun: true });
    assert.equal((await dry.svc.run()).posted, false);
    for (const x of [night, off, dry]) assert.equal(x.sent.length, 0);
  });

  it("no snapshots for the week → no post", async () => {
    const r = await rig();
    const res = await r.svc.run({ week: "2026-09-07" });
    assert.match(res.skipped.join(), /no daily snapshots/);
    assert.equal(r.sent.length, 0);
  });

  it("JSON report shape (what GET /mailbox-health/weekly returns)", async () => {
    const r = await rig();
    const report = await r.svc.report("2026-11-05");
    assert.ok(report);
    assert.deepEqual(Object.keys(report).sort(), [
      "domains", "groups", "inboxes", "priorSnapshotDates", "priorWeek", "snapshotDates", "totals", "week", "weekEnd",
    ]);
    assert.equal(report.week, "2026-11-02");
    assert.deepEqual(report.snapshotDates, ["2026-11-02", "2026-11-08"]);
    assert.deepEqual(report.priorSnapshotDates, ["2026-10-27"]);
    const inbox = report.inboxes[0]!;
    assert.deepEqual(Object.keys(inbox).sort(), ["domain", "email", "esp", "flags", "owner", "pod", "prior", "trend", "week"]);
    assert.deepEqual(Object.keys(inbox.week).sort(), ["bounceRate", "bounces", "days", "replies", "replyRate", "sent", "warmupScore"]);
    assert.deepEqual(Object.keys(inbox.trend).sort(), ["bounceRatePts", "replyRatePts", "warmupPts"]);
    assert.deepEqual(Object.keys(report.domains[0]!).sort(), [
      "domain", "flaggedInboxes", "flags", "inboxes", "owner", "pod", "prior", "trend", "week",
    ]);
    assert.deepEqual(Object.keys(report.groups[0]!).sort(), [
      "domains", "flaggedInboxes", "inboxes", "owner", "pod", "prior", "trend", "week",
    ]);
    assert.deepEqual(Object.keys(report.totals).sort(), [
      "domains", "flaggedDomains", "flaggedInboxes", "inboxes", "prior", "trend", "week",
    ]);
    assert.equal(await r.svc.report("2026-09-07"), null);
    // JSON round-trip is lossless (no Maps / Sets leak into the response).
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  });
});
