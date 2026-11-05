import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateReplyRateDrop,
  parseSenderReplyStats,
  REPLY_DROP_MIN_SENDS,
  REPLY_DROP_THRESHOLD,
} from "./replyRateDrop.js";

const box = (email: string, clientId = 1) => ({ email, clientId });
const stat = (email: string, sent: number, replied: number) => ({ email, sent, replied });

// Client 1: a@good.com and b@bad.com. 30-day baseline: 1000 sent, 20 replied = 2.0%.
const mailboxes = [box("a@good.com"), box("b@bad.com")];
const stats30 = [stat("a@good.com", 500, 15), stat("b@bad.com", 500, 5)];

describe("D311 reply-rate drop", () => {
  it("constants are Josh's: 150 sends, 40% below baseline", () => {
    assert.equal(REPLY_DROP_MIN_SENDS, 150);
    assert.equal(REPLY_DROP_THRESHOLD, 0.4);
  });

  it("flags a domain exactly 40% below baseline and not 39%", () => {
    // baseline = (15+5)/1000 = 2.0%; 40% below = 1.2%.
    const at40 = evaluateReplyRateDrop({
      mailboxes,
      stats30,
      stats7: [stat("a@good.com", 200, 4), stat("b@bad.com", 1000, 12)],
    });
    assert.deepEqual(at40.map((f) => f.domain), ["bad.com"]);
    assert.ok(Math.abs(at40[0]!.dropPercent - 40) < 1e-9);
    const at39 = evaluateReplyRateDrop({
      mailboxes,
      stats30,
      stats7: [stat("b@bad.com", 1000, 12.2)],
    });
    assert.deepEqual(at39, []);
  });

  it("needs 150+ sends in the 7-day window", () => {
    const stats7 = (sent: number) => [stat("b@bad.com", sent, 0)];
    assert.deepEqual(evaluateReplyRateDrop({ mailboxes, stats30, stats7: stats7(149) }), []);
    const hit = evaluateReplyRateDrop({ mailboxes, stats30, stats7: stats7(150) });
    assert.equal(hit.length, 1);
    assert.equal(hit[0]!.sent7, 150);
  });

  it("sums a domain's mailboxes before judging, per client baseline", () => {
    const out = evaluateReplyRateDrop({
      mailboxes: [box("x@one.com", 1), box("y@one.com", 1), box("z@two.com", 2)],
      stats30: [stat("x@one.com", 500, 10), stat("y@one.com", 500, 10), stat("z@two.com", 1000, 100)],
      stats7: [stat("x@one.com", 100, 0), stat("y@one.com", 100, 2), stat("z@two.com", 400, 20)],
    });
    // one.com: 2/200 = 1.0% vs client-1 baseline 2.0% -> 50% below. two.com: 5.0% vs 10.0% -> 50% below.
    assert.deepEqual(out.map((f) => f.domain).sort(), ["one.com", "two.com"]);
  });

  it("no baseline, a zero baseline, or a healthy rate never flags", () => {
    assert.deepEqual(
      evaluateReplyRateDrop({ mailboxes, stats30: [], stats7: [stat("b@bad.com", 500, 0)] }),
      [],
    );
    assert.deepEqual(
      evaluateReplyRateDrop({
        mailboxes,
        stats30: [stat("a@good.com", 500, 0), stat("b@bad.com", 500, 0)],
        stats7: [stat("b@bad.com", 500, 0)],
      }),
      [],
    );
    assert.deepEqual(
      evaluateReplyRateDrop({ mailboxes, stats30, stats7: [stat("b@bad.com", 500, 20)] }),
      [],
    );
  });

  it("parses name-wise health rows, summing repeats", () => {
    const rows = parseSenderReplyStats({
      data: [
        { from_email: "A@x.com", sent_count: "10", reply_count: 1 },
        { from_email: "a@x.com", sent_count: 5, reply_count: 0 },
        { from_email: "no-counts@x.com" },
      ],
    });
    assert.deepEqual(rows, [{ email: "a@x.com", sent: 15, replied: 1 }]);
  });
});
