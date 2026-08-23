import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "./store.js";

describe("isolation state", () => {
  it("reloads pod controls, mailbox tags, and suppressed terms", async () => {
    const path = `/tmp/dw-iso-state-${process.pid}-${Date.now()}.json`;
    const state = new StateStore(path);
    await state.load();
    state.upsertMailboxControl({
      email: "a@client.com",
      ranAt: "2026-08-23T00:00:00.000Z",
      placement: "SPAM",
      history: ["SPAM"],
      rollingFailCount: 1,
      tag: "watch",
    });
    state.upsertSuppressedTerm({
      term: "free",
      kind: "word",
      firstSeen: "2026-08-23T00:00:00.000Z",
      timesConfirmed: 1,
      status: "confirmed",
    });
    state.markCopySuspect({
      campaignId: 7,
      campaignName: "Acme",
      at: "2026-08-23T00:00:00.000Z",
    });
    await state.save();

    const reloaded = new StateStore(path);
    await reloaded.load();
    assert.equal(reloaded.getMailboxControl("A@client.com")?.tag, "watch");
    assert.equal(reloaded.listSuppressedTerms()[0]?.term, "free");
    assert.equal(reloaded.listCopySuspects()[0]?.campaignId, 7);
  });
});
