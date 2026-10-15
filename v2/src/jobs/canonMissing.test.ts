import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, writesAllowed } from "../config.js";
import { classifyCanaryFailure } from "../lib/isolation.js";
import { runReconnectTick } from "../lib/reconnect.js";
import { burnedRetireReason } from "../lib/retireReason.js";
import { runTerlTick } from "../lib/terl.js";
import { WriteGate } from "../shadow.js";
import { MemoryStore } from "../store.js";
import { runIsolationTick } from "./isolation.js";
import { runQaTick } from "./qa.js";
import { intendSpend } from "./spend.js";
import { runStaffTick } from "./staff.js";
import type { SlimAccount, SlimCampaign } from "../types.js";

function account(partial: Partial<SlimAccount> & Pick<SlimAccount, "id" | "email">): SlimAccount {
  return {
    fromName: "Ada Lovelace",
    clientId: 10,
    campaignIds: [100],
    tags: ["POD-A"],
    smtpOk: true,
    imapOk: true,
    messagePerDay: 30,
    warmupBlocked: false,
    createdAt: "2020-01-01T00:00:00.000Z",
    warmupStartedAt: "2020-01-01T00:00:00.000Z",
    signature: "Ada Lovelace\nAcme Outreach",
    ...partial,
  };
}

describe("two canary types classify sender vs copy", () => {
  it("warmed fail is sender; unwarmed fail is copy", () => {
    assert.equal(classifyCanaryFailure({ kind: "warmed", inboxPercent: 0 }), "sender");
    assert.equal(classifyCanaryFailure({ kind: "unwarmed", inboxPercent: 0 }), "copy");
    assert.equal(classifyCanaryFailure({ kind: "unwarmed", inboxPercent: 90 }), "none");
  });

  it("copy-canary fail hunts words and logs intended swap, not a write", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runIsolationTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [{ id: 3847940, name: "SG MSP Engagers", status: "ACTIVE", clientId: 1 }],
        accounts: [],
      },
      tests: [
        {
          id: "copy",
          name: "Canary copy: #3847940 SG MSP Engagers",
          senders: [{ email: "living@canary.test", inbox: false, provider: "gmail" }],
        },
        {
          id: "warm",
          name: "Auto: SG MSP Engagers",
          senders: [{ email: "warm@client.info", inbox: false, provider: "gmail" }],
        },
      ],
      fleetEmails: ["living@canary.test"],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      sequences: [
        {
          campaignId: 3847940,
          body: "I've got a pair of AirPods for you if you want.",
        },
      ],
      runQa: false,
    });
    const copyScore = (await store.listScores()).find((s) => s.source === "canary-copy");
    const warmScore = (await store.listScores()).find((s) => s.source === "live-placement");
    assert.equal(copyScore?.failureClass, "copy");
    assert.equal(warmScore?.failureClass, "sender");
    assert.ok(result.wordHunts >= 1);
    const hunt = result.intended.find((a) => a.kind === "word_hunt");
    assert.ok(hunt && hunt.shadowed && !hunt.executed);
    assert.match(String(hunt?.payload.swap ?? ""), /I'd like to offer/);
    assert.doesNotMatch(String(hunt?.payload.swap ?? ""), /air\s*pods?|\btickets?\b|\bTJ\b|free\s+poc/i);
  });
});

describe("QA ledger + lease", () => {
  it("records scheduled vs completed and yields if the other role holds the lease", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const book = {
      fetchedAt: new Date().toISOString(),
      campaigns: [{ id: 1, name: "Acme Outreach", status: "ACTIVE", clientId: 10 } satisfies SlimCampaign],
      accounts: [
        account({
          id: 1,
          email: "ada@acme.info",
        }),
      ],
    };
    const first = await runQaTick({
      book,
      role: "staff",
      trigger: "new_copy",
      store,
      gate,
      sequences: [{ campaignId: 1, body: "Hi {{first_name}} %signature%" }],
      leads: [{ campaignId: 1, customFields: { first_name: "" } }],
    });
    assert.equal(first.acquired, true);
    assert.ok(first.findings.some((f) => f.kind === "merge_tag_blank"));
    store.qaLease = { holder: "staff", token: "held", expiresAt: Date.now() + 60_000 };
    const second = await runQaTick({
      book,
      role: "isolation",
      trigger: "scheduled",
      store,
      gate,
    });
    assert.equal(second.acquired, false);
    const runs = await store.listQaRuns();
    assert.ok(runs.some((r) => r.status === "completed"));
    assert.ok(runs.some((r) => r.status === "missed"));
  });
});

describe("reconnect + TERRL intended in shadow", () => {
  it("D94 reconnects disconnected SMTP/IMAP without writing", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runReconnectTick({
      accounts: [account({ id: 2, email: "down@x.info", smtpOk: false, imapOk: true })],
      gate,
    });
    assert.equal(result.disconnected, 1);
    assert.ok(result.intended.every((a) => a.kind === "reconnect" && !a.executed));
  });

  it("D219 5.7.233 holds 24h and intends a same-client substitute", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const campaign: SlimCampaign = { id: 100, name: "Acme Outreach", status: "ACTIVE", clientId: 10 };
    const stopped = account({ id: 1, email: "held@contoso.info", tags: ["POD-A", "type:m365"] });
    const spare = account({
      id: 2,
      email: "spare@acme.info",
      campaignIds: [],
      tags: [],
    });
    const result = await runTerlTick({
      book: { fetchedAt: new Date().toISOString(), campaigns: [campaign], accounts: [stopped, spare] },
      events: [{ accountId: 1, email: "held@contoso.info", smtp: "550 5.7.233 tenant limit" }],
      gate,
      store,
    });
    assert.ok(result.intended.some((a) => a.kind === "mpd_write" && a.payload.maxEmailPerDay === 0));
    assert.ok(result.intended.some((a) => a.kind === "attach" && a.payload.reason === "terrl_substitute"));
    const holds = await store.listHolds();
    assert.ok(holds.some((h) => h.reason === "tenant_rate_limit" && h.expiresAt));
  });
});

describe("burned-retire reason + spend intents", () => {
  it("retire recommendations are one sentence", () => {
    const reason = burnedRetireReason({
      domain: "boldercyperpartnerhub.info",
      bounceClass: "tenant_outbound_block",
    });
    assert.equal(reason.endsWith("."), true);
    assert.equal(reason.split(/(?<=[.!?])\s+/).length, 1);
  });

  it("refuse a retire ask with no reason", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    await assert.rejects(
      () =>
        intendSpend(
          { id: "x", kind: "retire_domain", amountUsd: 25, payload: {} },
          gate,
          loadConfig({} as NodeJS.ProcessEnv),
        ),
      /one-sentence reason/,
    );
  });

  it("canary/domain buys stay intended; execute throws at cutover", async () => {
    const store = new MemoryStore();
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    const gate = new WriteGate(cfg, store);
    const action = await intendSpend(
      {
        id: "canary",
        kind: "buy_mailboxes",
        amountUsd: 25,
        payload: { reason: "living canary fleet is under 10 seats" },
      },
      gate,
      cfg,
    );
    assert.equal(action.kind, "spend");
    assert.equal(action.executed, false);
    assert.equal(writesAllowed(cfg), false);
  });
});

describe("staff still reconnects on the 15m tick", () => {
  it("surfaces smtp_imap_disconnected from runStaffTick", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [{ id: 100, name: "Acme Outreach", status: "ACTIVE", clientId: 10 }],
        accounts: [account({ id: 1, email: "down@acme.info", smtpOk: false })],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.ok(result.findings.some((f) => f.kind === "smtp_imap_disconnected"));
    assert.ok(result.intended.some((a) => a.kind === "reconnect" && a.shadowed));
  });
});
