import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MailboxHealthRow, MailboxHealthTrend } from "./mailboxHealthDaily.js";
import {
  buildWeeklyHealthReport,
  lastCompletedWeek,
  loadWeeklyHealthConfig,
  parseWeekParam,
  weekStartOf,
  weeklyHealthSlackText,
  type WeeklyInputDay,
} from "./mailboxHealthWeekly.js";
import { mailboxHealthCronError } from "./mailboxHealthDaily.js";

function row(
  date: string,
  email: string,
  over: Partial<MailboxHealthRow> = {},
): MailboxHealthRow {
  return {
    date,
    email,
    domain: email.split("@")[1]!,
    emailAccountId: 1,
    esp: "GOOGLE",
    pod: "A",
    owner: "acme",
    ownerClientId: 1,
    sent: 100,
    replies: 2,
    bounces: 1,
    replyRate: 2,
    bounceRate: 1,
    warmupScore: 98,
    ...over,
  };
}

function day(date: string, rows: MailboxHealthRow[], trends: MailboxHealthTrend[] = []): WeeklyInputDay {
  return { date, rows: Object.fromEntries(rows.map((r) => [r.email, r])), trends };
}

// Week of Mon 2026-11-02 .. Sun 2026-11-08; prior week Mon 2026-10-26.
const WEEK = "2026-11-02";
const cur = [
  day("2026-11-02", [
    row("2026-11-02", "a@one.com"),
    row("2026-11-02", "b@one.com", { pod: "B", bounces: 5 }),
    row("2026-11-02", "c@two.io", { owner: "beta", pod: "B", warmupScore: 88 }),
    row("2026-11-02", "p@pool.co", { owner: null, pod: null, sent: null, replies: null, bounces: null }),
  ], [
    { date: "2026-11-02", email: "b@one.com", domain: "one.com", owner: "acme", pod: "B", flag: "bounce_rate_high", detail: "x" },
  ]),
  day("2026-11-03", [
    row("2026-11-03", "a@one.com", { replies: 4 }),
    row("2026-11-03", "b@one.com", { pod: "B", bounces: 5 }),
    row("2026-11-03", "c@two.io", { owner: "beta", pod: "B", warmupScore: 85 }),
  ], [
    { date: "2026-11-03", email: "c@two.io", domain: "two.io", owner: "beta", pod: "B", flag: "warmup_low", detail: "y" },
    { date: "2026-11-03", email: "b@one.com", domain: "one.com", owner: "acme", pod: "B", flag: "bounce_rate_high", detail: "x" },
  ]),
  // Outside the week: ignored.
  day("2026-11-09", [row("2026-11-09", "z@late.com")]),
];
const prior = [
  day("2026-10-27", [
    row("2026-10-27", "a@one.com", { sent: 100, replies: 4, bounces: 0 }),
    row("2026-10-27", "b@one.com", { pod: "B", sent: 100, replies: 2, bounces: 1 }),
    row("2026-10-27", "c@two.io", { owner: "beta", pod: "B", warmupScore: 95 }),
  ]),
];

describe("D335 weekly mailbox health — report", () => {
  const r = buildWeeklyHealthReport({ week: WEEK, days: cur, priorDays: prior });

  it("renders per inbox: weekly sums, rates, newest warmup, flags", () => {
    assert.equal(r.week, "2026-11-02");
    assert.equal(r.weekEnd, "2026-11-08");
    assert.equal(r.priorWeek, "2026-10-26");
    assert.deepEqual(r.snapshotDates, ["2026-11-02", "2026-11-03"]);
    assert.equal(r.inboxes.length, 4, "z@late.com is outside the week");
    const a = r.inboxes.find((i) => i.email === "a@one.com")!;
    assert.deepEqual(
      { sent: a.week.sent, replies: a.week.replies, bounces: a.week.bounces, days: a.week.days },
      { sent: 200, replies: 6, bounces: 2, days: 2 },
    );
    assert.equal(a.week.replyRate, 3);
    assert.equal(a.week.bounceRate, 1);
    assert.deepEqual(a.flags, []);
    const c = r.inboxes.find((i) => i.email === "c@two.io")!;
    assert.equal(c.week.warmupScore, 85, "newest warmup in the week wins");
    assert.deepEqual(c.flags, ["warmup_low"]);
    const b = r.inboxes.find((i) => i.email === "b@one.com")!;
    assert.deepEqual(b.flags, ["bounce_rate_high"], "flags are distinct across days");
    const p = r.inboxes.find((i) => i.email === "p@pool.co")!;
    assert.equal(p.week.sent, 0);
    assert.equal(p.week.replyRate, null, "no sends → null rate, not 0");
    assert.equal(p.prior, null);
    // flagged first
    assert.ok(r.inboxes[0]!.flags.length > 0);
  });

  it("week-over-week trend per inbox in percentage points", () => {
    const a = r.inboxes.find((i) => i.email === "a@one.com")!;
    assert.equal(a.prior!.replyRate, 4);
    assert.equal(a.trend.replyRatePts, -1);
    assert.equal(a.trend.bounceRatePts, 1);
    const c = r.inboxes.find((i) => i.email === "c@two.io")!;
    assert.equal(c.trend.warmupPts, -10);
    const b = r.inboxes.find((i) => i.email === "b@one.com")!;
    assert.equal(b.trend.bounceRatePts, 4);
  });

  it("renders per domain: summed counts, mean warmup, flagged inbox count, mixed POD → null", () => {
    const one = r.domains.find((d) => d.domain === "one.com")!;
    assert.equal(one.inboxes, 2);
    assert.equal(one.flaggedInboxes, 1);
    assert.equal(one.owner, "acme");
    assert.equal(one.pod, null, "a@ is POD-A, b@ is POD-B");
    assert.equal(one.week.sent, 400);
    assert.equal(one.week.bounces, 12);
    assert.equal(one.week.bounceRate, 3);
    assert.equal(one.prior!.bounceRate, 0.5);
    assert.equal(one.trend.bounceRatePts, 2.5);
    assert.deepEqual(one.flags, ["bounce_rate_high"]);
    const two = r.domains.find((d) => d.domain === "two.io")!;
    assert.equal(two.pod, "B");
    assert.equal(two.week.warmupScore, 85);
    assert.equal(r.domains[r.domains.length - 1]!.flaggedInboxes, 0, "flagged domains first");
  });

  it("groups by sg-owner and POD", () => {
    const keys = r.groups.map((g) => `${g.owner ?? "pool"}/${g.pod ?? "-"}`);
    assert.deepEqual(keys, ["acme/A", "acme/B", "beta/B", "pool/-"]);
    const acmeB = r.groups.find((g) => g.owner === "acme" && g.pod === "B")!;
    assert.equal(acmeB.inboxes, 1);
    assert.equal(acmeB.flaggedInboxes, 1);
    assert.equal(acmeB.week.sent, 200);
  });

  it("totals and counts", () => {
    assert.equal(r.totals.inboxes, 4);
    assert.equal(r.totals.domains, 3);
    assert.equal(r.totals.flaggedInboxes, 2);
    assert.equal(r.totals.flaggedDomains, 2);
    assert.equal(r.totals.week.sent, 600);
  });

  it("Slack text is concise: totals, groups, top flagged items, the endpoint", () => {
    const text = weeklyHealthSlackText(r);
    assert.match(text, /^\*Weekly mailbox health — 2026-11-02 to 2026-11-08\*/);
    assert.match(text, /4 inboxes · 3 domains · 600 sent/);
    assert.match(text, /flagged 2 inboxes \/ 2 domains/);
    assert.match(text, /• acme · POD-B — 1 inboxes/);
    assert.match(text, /\*Top flagged inboxes\* \(2\)/);
    assert.match(text, /• b@one\.com \(acme · POD-B\) bounce_rate_high/);
    assert.match(text, /\*Top flagged domains\* \(2\)/);
    assert.match(text, /GET \/mailbox-health\/weekly\?week=2026-11-02/);
    assert.doesNotMatch(text, /a@one\.com/, "unflagged inboxes are not dumped");
  });

  it("caps the Slack lists", () => {
    const many = Array.from({ length: 30 }, (_, i) => row(WEEK, `m${i}@d${i}.com`, { owner: `o${i}` }));
    const trends = many.map((m) => ({ date: WEEK, email: m.email, domain: m.domain, owner: m.owner, pod: m.pod, flag: "warmup_low" as const, detail: "" }));
    const big = buildWeeklyHealthReport({ week: WEEK, days: [day(WEEK, many, trends)], priorDays: [] });
    const lines = weeklyHealthSlackText(big).split("\n");
    assert.ok(lines.length <= 35, `got ${lines.length} lines`);
    assert.ok(lines.some((l) => /…and 22 more groups/.test(l)));
  });
});

describe("D335 weekly mailbox health — weeks and config", () => {
  it("week param normalizes to its Monday; bad input is null", () => {
    assert.equal(weekStartOf("2026-11-08"), "2026-11-02"); // Sunday
    assert.equal(weekStartOf("2026-11-02"), "2026-11-02");
    assert.equal(parseWeekParam("2026-11-05"), "2026-11-02");
    assert.equal(parseWeekParam("nope"), null);
    assert.equal(parseWeekParam("2026-13-40"), null);
  });

  it("last completed week is the Mon–Sun before this CT week", () => {
    // Monday 2026-11-09 8:30am CST
    assert.equal(lastCompletedWeek(new Date("2026-11-09T14:30:00Z")), "2026-11-02");
    // Sunday 2026-11-08 11pm CST is still the week of 11-02 → last completed is 10-26
    assert.equal(lastCompletedWeek(new Date("2026-11-09T05:00:00Z")), "2026-10-26");
  });

  it("defaults: on, Monday 8:30am CT, inside allowed hours; only explicit off disables", () => {
    const cfg = loadWeeklyHealthConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.cron, "30 8 * * 1");
    assert.equal(mailboxHealthCronError(cfg.cron, "CRON_WEEKLY_HEALTH_REPORT"), null);
    assert.equal(loadWeeklyHealthConfig({ WEEKLY_HEALTH_REPORT_ENABLED: "false" }).enabled, false);
    assert.match(
      mailboxHealthCronError("30 21 * * 1", "CRON_WEEKLY_HEALTH_REPORT")!,
      /CRON_WEEKLY_HEALTH_REPORT fires at 21h/,
    );
    assert.ok(mailboxHealthCronError("0 5 * * 1", "CRON_WEEKLY_HEALTH_REPORT"));
  });
});
