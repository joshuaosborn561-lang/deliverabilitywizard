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
    assert.ok(again.some((a) => a.kind === "spend"));
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
