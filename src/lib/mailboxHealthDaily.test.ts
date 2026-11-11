import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CANON_CORE_KINDS } from "./canonCompliance.js";
import {
  addDays,
  buildMailboxHealthRows,
  evaluateMailboxHealthTrends,
  inMailboxHealthHours,
  loadMailboxHealthConfig,
  mailboxHealthCronError,
  MAILBOX_HEALTH_DEFAULT_CRON,
  MAILBOX_HEALTH_TREND_KIND,
  parseSenderDayStats,
  parseWarmupScore,
  snapshotDateFor,
  trendFinding,
  type MailboxHealthHistory,
  type MailboxHealthRow,
} from "./mailboxHealthDaily.js";

const cfg = loadMailboxHealthConfig({});
const D = "2026-11-10";
const EMAIL = "jo@acme.com";

function row(date: string, p: Partial<MailboxHealthRow> = {}): MailboxHealthRow {
  const sent = p.sent ?? 0;
  return {
    date,
    email: EMAIL,
    domain: "acme.com",
    emailAccountId: 1,
    esp: "GOOGLE",
    pod: "A",
    owner: "salesglider",
    ownerClientId: 345263,
    sent,
    replies: p.replies ?? 0,
    bounces: p.bounces ?? 0,
    replyRate: null,
    bounceRate: null,
    warmupScore: p.warmupScore === undefined ? 100 : p.warmupScore,
    ...p,
  };
}

/** days[0] is `D`, days[1] is D-1, … */
function history(days: Array<Partial<MailboxHealthRow> | null>): MailboxHealthHistory {
  const h: MailboxHealthHistory = new Map();
  days.forEach((p, i) => {
    if (!p) return;
    const date = addDays(D, -i);
    h.set(date, new Map([[EMAIL, row(date, p)]]));
  });
  return h;
}

const flags = (h: MailboxHealthHistory) =>
  evaluateMailboxHealthTrends(D, h, cfg).map((t) => t.flag).sort();

describe("D334 mailbox health — config defaults", () => {
  it("ships the proposed defaults, env-overridable", () => {
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.alertsEnabled, true);
    assert.equal(cfg.cron, "15 7 * * *");
    assert.equal(cfg.retentionDays, 120);
    assert.equal(cfg.bounceRateMaxPct, 3);
    assert.equal(cfg.bounceRollingDays, 7);
    assert.equal(cfg.bounceRisingDays, 3);
    assert.equal(cfg.replyDropPct, 50);
    assert.equal(cfg.replyRecentDays, 7);
    assert.equal(cfg.replyBaselineDays, 14);
    assert.equal(cfg.replyMinSent, 100);
    assert.equal(cfg.warmupMinScore, 90);
    assert.equal(cfg.warmupDropPoints, 5);
    const o = loadMailboxHealthConfig({
      MAILBOX_HEALTH_DAILY_ENABLED: "false",
      MAILBOX_HEALTH_ALERTS_ENABLED: "0",
      MAILBOX_HEALTH_BOUNCE_RATE_MAX_PCT: "5",
      MAILBOX_HEALTH_REPLY_MIN_SENT: "nope",
    });
    assert.equal(o.enabled, false);
    assert.equal(o.alertsEnabled, false);
    assert.equal(o.bounceRateMaxPct, 5);
    assert.equal(o.replyMinSent, 100, "garbage falls back to the default");
  });

  it("mailbox_health_trend is not a core canon kind (alert only, never flips canonCompliant)", () => {
    assert.equal((CANON_CORE_KINDS as readonly string[]).includes(MAILBOX_HEALTH_TREND_KIND), false);
  });
});

describe("D334 mailbox health — cron hour guard (no timer 20:00–05:59 CT)", () => {
  it("accepts the default and daytime hours", () => {
    assert.equal(mailboxHealthCronError(MAILBOX_HEALTH_DEFAULT_CRON), null);
    for (const e of ["0 6 * * *", "59 19 * * *", "15 7,13 * * *", "0 8-17/3 * * 1-5", "0 15 7 * * *"]) {
      assert.equal(mailboxHealthCronError(e), null, e);
    }
  });

  it("rejects every hour from 20:00 through 05:59 CT", () => {
    for (let h = 0; h < 24; h += 1) {
      const err = mailboxHealthCronError(`15 ${h} * * *`);
      if (h >= 20 || h < 6) assert.ok(err, `hour ${h} must be rejected`);
      else assert.equal(err, null, `hour ${h} must be allowed`);
    }
    assert.ok(mailboxHealthCronError("59 5 * * *"), "05:59 is quiet");
  });

  it("rejects wildcards, steps and ranges that reach quiet hours, and junk", () => {
    for (const e of ["15 * * * *", "0 */6 * * *", "0 18-21 * * *", "0 7,22 * * *", "0 5/2 * * *", "bad", "0 x * * *", "0 25 * * *"]) {
      assert.ok(mailboxHealthCronError(e), e);
    }
  });

  it("runtime hours guard is America/Chicago 06:00–19:59", () => {
    assert.equal(inMailboxHealthHours(new Date("2026-11-11T13:15:00Z")), true); // 7:15 CST
    assert.equal(inMailboxHealthHours(new Date("2026-11-12T02:00:00Z")), false); // 20:00 CST
    assert.equal(inMailboxHealthHours(new Date("2026-11-11T11:59:00Z")), false); // 05:59 CST
  });

  it("snapshot is the previous Chicago day", () => {
    assert.equal(snapshotDateFor(new Date("2026-11-11T13:15:00Z")), "2026-11-10");
  });
});

describe("D334 mailbox health — snapshot math", () => {
  it("parses warmup_reputation strings and numbers", () => {
    assert.equal(parseWarmupScore("100%"), 100);
    assert.equal(parseWarmupScore(" 97.5 % "), 97.5);
    assert.equal(parseWarmupScore(88), 88);
    assert.equal(parseWarmupScore(""), null);
    assert.equal(parseWarmupScore("n/a"), null);
    assert.equal(parseWarmupScore(undefined), null);
  });

  it("sums per-email rows and computes rates; only ACTIVE-campaign mailboxes; owner/pod/esp read-only", () => {
    const stats = parseSenderDayStats({
      data: {
        email_health_metrics: [
          { from_email: "Jo@Acme.com", sent_count: "60", reply_count: 2, bounce_count: 1 },
          { from_email: "jo@acme.com", sent_count: 40, reply_count: 1, bounce_count: 2 },
          { from_email: "ms@beta.io", sent_count: 0, reply_count: 0, bounce_count: 0 },
        ],
      },
    });
    assert.deepEqual(stats.get("jo@acme.com"), { email: "jo@acme.com", sent: 100, replies: 3, bounces: 3 });
    const rows = buildMailboxHealthRows({
      date: D,
      campaigns: [
        { id: 1, name: "Live", status: "ACTIVE" },
        { id: 2, name: "Paused", status: "PAUSED" },
      ] as never,
      accounts: [
        {
          id: 10,
          from_email: "jo@acme.com",
          type: "GMAIL",
          campaign_ids: [1],
          client_id: 345263,
          owner_slug: "salesglider",
          tags: [{ tag_name: "POD-A" }],
          warmup_details: { warmup_reputation: "98%" },
        },
        { id: 11, from_email: "ms@beta.io", type: "OUTLOOK", campaign_ids: [1], client_id: null, warmup_details: {} },
        { id: 12, from_email: "nope@x.com", type: "SMTP", campaign_ids: [3], warmup_details: {} },
        { id: 13, from_email: "idle@x.com", type: "SMTP", campaign_ids: [1], warmup_details: { warmup_reputation: "71" } },
      ] as never,
      stats,
    });
    assert.deepEqual(rows.map((r) => r.email), ["idle@x.com", "jo@acme.com", "ms@beta.io"]);
    const jo = rows.find((r) => r.email === "jo@acme.com")!;
    assert.equal(jo.domain, "acme.com");
    assert.equal(jo.esp, "GOOGLE");
    assert.equal(jo.pod, "A");
    assert.equal(jo.owner, "salesglider");
    assert.equal(jo.sent, 100);
    assert.equal(jo.replyRate, 3);
    assert.equal(jo.bounceRate, 3);
    assert.equal(jo.warmupScore, 98);
    const ms = rows.find((r) => r.email === "ms@beta.io")!;
    assert.equal(ms.esp, "MICROSOFT");
    assert.equal(ms.owner, null);
    assert.equal(ms.sent, 0);
    assert.equal(ms.replyRate, null, "0 sent has no rate");
    const idle = rows.find((r) => r.email === "idle@x.com")!;
    assert.equal(idle.esp, "OTHER");
    assert.equal(idle.sent, null, "no metrics row → null, not 0");
    assert.equal(idle.warmupScore, 71);
  });
});

describe("D334 mailbox health — trend flags", () => {
  it("quiet mailbox: no flags", () => {
    assert.deepEqual(flags(history(Array.from({ length: 21 }, () => ({ sent: 50, replies: 2, bounces: 0 })))), []);
  });

  it("bounce_rate_high fires over 3% on the 7-day rolling window", () => {
    const h = history([
      { sent: 30, bounces: 2 },
      { sent: 30, bounces: 1 },
      { sent: 30, bounces: 1 },
      { sent: 0 },
      { sent: 0 },
      { sent: 30, bounces: 0 },
      { sent: 30, bounces: 1 },
    ]); // 5 / 150 = 3.33%
    assert.deepEqual(flags(h).filter((f) => f === "bounce_rate_high"), ["bounce_rate_high"]);
  });

  it("bounce_rate_high does not fire below min volume", () => {
    const h = history([{ sent: 20, bounces: 5 }, { sent: 20, bounces: 0 }]); // 40 < 50 sends
    assert.equal(flags(h).includes("bounce_rate_high"), false);
  });

  it("bounce_rate_rising fires on 3 sending days in a row, skipping the weekend", () => {
    const h = history([
      { sent: 40, bounces: 1 }, // 2.5%  (D)
      { sent: 0 }, // weekend
      { sent: 0 },
      { sent: 50, bounces: 1 }, // 2%
      { sent: 100, bounces: 1 }, // 1%
    ]);
    assert.ok(flags(h).includes("bounce_rate_rising"));
  });

  it("bounce_rate_rising does not fire below daily min volume or when flat", () => {
    const low = history([{ sent: 10, bounces: 3 }, { sent: 10, bounces: 2 }, { sent: 10, bounces: 1 }]);
    assert.equal(flags(low).includes("bounce_rate_rising"), false);
    const flat = history([{ sent: 50, bounces: 1 }, { sent: 50, bounces: 1 }, { sent: 50, bounces: 0 }]);
    assert.equal(flags(flat).includes("bounce_rate_rising"), false);
  });

  it("reply_rate_drop fires when the 7-day rate is >50% below the prior 14-day baseline", () => {
    // recent 7d: 140 sent / 1 reply (0.71%); baseline 14d: 280 sent / 7 replies (2.5%)
    const days: Array<Partial<MailboxHealthRow>> = [];
    for (let i = 0; i < 21; i += 1) days.push(i < 7 ? { sent: 20, replies: i === 0 ? 1 : 0 } : { sent: 20, replies: i % 2 ? 1 : 0 });
    assert.ok(flags(history(days)).includes("reply_rate_drop"));
  });

  it("reply_rate_drop does not fire below 100 sends in either window", () => {
    const thinRecent: Array<Partial<MailboxHealthRow>> = [];
    for (let i = 0; i < 21; i += 1) thinRecent.push(i < 7 ? { sent: 10, replies: 0 } : { sent: 20, replies: 1 });
    assert.equal(flags(history(thinRecent)).includes("reply_rate_drop"), false, "recent 70 < 100");
    const thinBase: Array<Partial<MailboxHealthRow>> = [];
    for (let i = 0; i < 21; i += 1) thinBase.push(i < 7 ? { sent: 20, replies: 0 } : { sent: 5, replies: 1 });
    assert.equal(flags(history(thinBase)).includes("reply_rate_drop"), false, "baseline 70 < 100");
  });

  it("warmup_low fires under 90; missing score never fires", () => {
    assert.ok(flags(history([{ warmupScore: 89 }])).includes("warmup_low"));
    assert.equal(flags(history([{ warmupScore: 90 }])).includes("warmup_low"), false);
    assert.equal(flags(history([{ warmupScore: null }])).includes("warmup_low"), false);
  });

  it("warmup_drop fires on ≥5 points week over week; not without a reading 7 days back", () => {
    const days: Array<Partial<MailboxHealthRow> | null> = Array.from({ length: 8 }, () => ({ warmupScore: 100 }));
    days[0] = { warmupScore: 95 };
    assert.ok(flags(history(days)).includes("warmup_drop"));
    days[0] = { warmupScore: 96 };
    assert.equal(flags(history(days)).includes("warmup_drop"), false);
    days[0] = { warmupScore: 80 };
    days[7] = null;
    assert.deepEqual(flags(history(days)), ["warmup_low"]);
  });

  it("finding string is the mailbox_health_trend canon kind", () => {
    const [t] = evaluateMailboxHealthTrends(D, history([{ warmupScore: 50 }]), cfg);
    assert.match(trendFinding(t!), /^mailbox_health_trend: jo@acme\.com warmup_low — /);
  });
});
