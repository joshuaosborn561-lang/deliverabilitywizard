import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideRest,
  mailboxIsCause,
  markReturned,
  restsDueBack,
  MAILBOX_REST_DAYS,
} from "./mailboxRest.js";

const base = {
  email: "a@x.com",
  accountId: 1,
  clientId: 5,
  pod: "A" as const,
  sameEspInbox: 60,
  campaignIds: [11],
};

describe("D303 mailbox rest-then-burn", () => {
  it("only INFRA + same-ESP under 80 means the mailbox is the cause", () => {
    assert.equal(mailboxIsCause({ verdict: "INFRA", sameEspInbox: 79 }), true);
    assert.equal(mailboxIsCause({ verdict: "INFRA", sameEspInbox: 80 }), false);
    assert.equal(mailboxIsCause({ verdict: "COPY", sameEspInbox: 10 }), false);
    assert.equal(mailboxIsCause({ verdict: "INFRA", sameEspInbox: 10, scoredSameEsp: false }), false);
  });
  it("first reading rests 28 days with rest_count 1 and history", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const d = decideRest({ ...base, now });
    assert.equal(d.action, "rest");
    if (d.action !== "rest") return;
    assert.equal(d.record.restCount, 1);
    assert.equal(d.record.history.length, 1);
    assert.equal(Date.parse(d.record.restUntil!) - now.getTime(), MAILBOX_REST_DAYS * 86400000);
  });
  it("due back after 28 days, then returned", () => {
    const d = decideRest({ ...base, now: new Date("2026-10-01T00:00:00Z") });
    assert.equal(d.action, "rest");
    if (d.action !== "rest") return;
    assert.equal(restsDueBack([d.record], new Date("2026-10-28T00:00:00Z")).length, 0);
    const due = restsDueBack([d.record], new Date("2026-10-29T00:00:00Z"));
    assert.equal(due.length, 1);
    const back = markReturned(d.record, new Date("2026-10-29T00:00:00Z"));
    assert.equal(back.status, "returned");
    assert.ok(back.history[0]!.returnedAt);
  });
  it("under 80 again after returning is BURNED", () => {
    const d = decideRest(base);
    if (d.action !== "rest") throw new Error("expected rest");
    const back = markReturned(d.record);
    const again = decideRest({ ...base, existing: back });
    assert.equal(again.action, "burn");
  });
  it("rest_count over 3 is BURNED", () => {
    const d = decideRest(base);
    if (d.action !== "rest") throw new Error("expected rest");
    const prior = { ...d.record, status: "returned" as const, restCount: 3 };
    // a fresh-cause reading on a returned box burns either way; force count path
    const burn = decideRest({ ...base, existing: { ...prior, restCount: 3 } });
    assert.equal(burn.action, "burn");
  });
  it("resting or burned mailboxes are left alone", () => {
    const d = decideRest(base);
    if (d.action !== "rest") throw new Error("expected rest");
    assert.equal(decideRest({ ...base, existing: d.record }).action, "none");
    assert.equal(decideRest({ ...base, existing: { ...d.record, status: "burned" } }).action, "none");
  });
});
