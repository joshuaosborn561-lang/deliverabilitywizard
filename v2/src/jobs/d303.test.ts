import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { WriteGate } from "../shadow.js";
import { MemoryStore } from "../store.js";
import { restMailboxIntents, returnDueRestIntents, variantTestIntents } from "./d303.js";
import type { IntendedAction, SlimAccount } from "../types.js";

function acct(id: number, email: string, extra: Partial<SlimAccount> = {}): SlimAccount {
  return {
    id, email, fromName: "", clientId: 5, campaignIds: [], tags: ["POD-A"], smtpOk: true, imapOk: true,
    messagePerDay: 30, warmupBlocked: false, createdAt: "2026-01-01T00:00:00Z", warmupStartedAt: "2026-01-01T00:00:00Z", signature: "",
    ...extra,
  };
}

describe("v2 D303 jobs (shadow intents only)", () => {
  it("rests a mailbox with a covering generic, returns it after 14 days, burns on repeat", async () => {
    const store = new MemoryStore();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const gate = new WriteGate(config, store);
    assert.equal(gate.allowed(), false);
    await store.upsertGeneric({ accountId: 90, email: "gen@pool.com", assignedClientId: null, assignedPod: null, assignedAt: null, releasedAt: null, reason: null });
    const book = {
      fetchedAt: "",
      campaigns: [{ id: 11, name: "C", status: "ACTIVE", clientId: 5 }],
      accounts: [acct(1, "box@client.com", { campaignIds: [11] }), acct(90, "gen@pool.com", { clientId: null })],
    };
    const intended: IntendedAction[] = [];
    const now = new Date("2026-10-26T12:00:00Z");
    const handled = await restMailboxIntents({
      campaign: book.campaigns[0]!, causes: [{ email: "box@client.com", sameEspInbox: 40 }],
      book, store, gate, config, intended, now,
    });
    assert.deepEqual(handled, ["box@client.com"]);
    assert.ok(intended.some((a) => a.kind === "detach" && a.email === "box@client.com"));
    assert.ok(intended.some((a) => a.kind === "attach" && a.email === "gen@pool.com"));
    assert.ok(intended.every((a) => a.executed === false));
    const rec = (await store.listMailboxRests())[0]!;
    assert.equal(rec.status, "resting");
    assert.equal(rec.coveringGeneric, "gen@pool.com");

    const back: IntendedAction[] = [];
    const n = await returnDueRestIntents({ book, store, gate, intended: back, now: new Date("2026-11-10T12:00:00Z") });
    assert.equal(n, 1);
    assert.ok(back.some((a) => a.kind === "attach" && a.email === "box@client.com"));
    assert.ok(back.some((a) => a.kind === "detach" && a.email === "gen@pool.com"));

    const again: IntendedAction[] = [];
    await restMailboxIntents({
      campaign: book.campaigns[0]!, causes: [{ email: "box@client.com", sameEspInbox: 30 }],
      book, store, gate, config, intended: again, now: new Date("2026-11-11T12:00:00Z"),
    });
    assert.equal((await store.listMailboxRests())[0]!.status, "burned");
    const spend = again.find((a) => a.kind === "spend");
    assert.ok(spend);
    assert.equal(spend!.payload.spendKind, "retire_mailbox");
    assert.equal(spend!.payload.amountUsd, 0);
    assert.equal(spend!.payload.domain, undefined);
  });

  it("intends one test_create per missing variant test", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const intended: IntendedAction[] = [];
    const n = await variantTestIntents({
      campaign: { id: 9, name: "C", status: "ACTIVE", clientId: 5 },
      sequences: [{ campaignId: 9, body: "", seqNumber: 1, variants: [{ id: 1, label: "A" }, { id: 2, label: "B" }, { id: 3, label: "C" }] }],
      tests: [], gate, intended,
    });
    assert.equal(n, 4);
    assert.ok(intended.every((a) => a.kind === "test_create" && a.executed === false));
  });
});

import { runStaffTick } from "./staff.js";

describe("v2 D303 whole-POD rebalance", () => {
  it("swaps across every campaign of the client's on-week POD", async () => {
    const store = new MemoryStore();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const gate = new WriteGate(config, store);
    const now = new Date("2026-10-26T15:00:00Z");
    const { onWeekPod } = await import("../lib/staffable.js");
    const tag = `POD-${onWeekPod(now)}`;
    const mk = (id: number, email: string, campaignIds: number[]) =>
      ({ id, email, fromName: "", clientId: 5, campaignIds, tags: [tag], smtpOk: true, imapOk: true, messagePerDay: 30, warmupBlocked: false, createdAt: "2026-01-01T00:00:00Z", warmupStartedAt: "2026-01-01T00:00:00Z", signature: "" });
    const accounts = [
      ...Array.from({ length: 10 }, (_, i) => mk(i + 1, `g${i}@gmail.com`, [11, 12])),
      ...Array.from({ length: 10 }, (_, i) => mk(50 + i, `m${i}@x.com`, [12])),
      ...Array.from({ length: 6 }, (_, i) => mk(80 + i, `s${i}@x.com`, [])),
    ];
    const result = await runStaffTick({
      book: { fetchedAt: now.toISOString(), campaigns: [
        { id: 11, name: "One", status: "ACTIVE", clientId: 5 },
        { id: 12, name: "Two", status: "ACTIVE", clientId: 5 },
      ], accounts },
      fleetEmails: [], gate, store, config, now, runQa: false,
      inboxkitShares: new Map([[5, 0.8]]),
    });
    const rebalance = result.intended.filter((a) => (a.payload as { reason?: string }).reason === "d303_esp_rebalance");
    assert.ok(rebalance.length > 0);
    const campaigns = new Set(rebalance.map((a) => a.campaignId));
    assert.ok(campaigns.has(11) && campaigns.has(12), "both campaigns of the POD get swaps");
    assert.ok(rebalance.every((a) => a.executed === false));
  });
});
