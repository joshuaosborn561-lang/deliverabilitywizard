import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";
import { WriteGate } from "./shadow.js";
import { MemoryStore } from "./store.js";
import { runStaffTick } from "./jobs/staff.js";
import { InboxkitReader } from "./clients/inboxkit.js";
import { dedupeFindings } from "./lib/findings.js";
import { budgetSignal } from "./lib/tickClock.js";
import { desiredMailboxSignature, signatureMismatch } from "./lib/signature.js";
import type { Finding, SlimAccount } from "./types.js";

function seat(partial: Partial<SlimAccount> & Pick<SlimAccount, "id" | "email">): SlimAccount {
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
    signature: "Ada Lovelace\nAcme Co",
    ...partial,
  };
}

describe("D298 signatures keep person name + client brand (old wizard parity)", () => {
  it("never uses the campaign name as the brand", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [{ id: 100, name: "Caller Calls Owners NBA", status: "ACTIVE", clientId: 10 }],
        accounts: [seat({ id: 1, email: "a@x.test" })],
        clients: [{ id: 10, name: "Acme Co", logo: "Acme Co" }],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
    });
    assert.equal(result.intended.filter((a) => a.kind === "signature_write").length, 0);
    assert.equal(result.findings.filter((f) => f.kind === "mailbox_sig").length, 0);
  });

  it("keeps the existing brand line when the client record is missing", () => {
    assert.equal(desiredMailboxSignature({ fromName: "Ada Lovelace", signature: "Ada Lovelace\nAcme Co" }), "Ada Lovelace\nAcme Co");
  });

  it("no brand and no signature: no write, never a placeholder", () => {
    assert.equal(signatureMismatch({ fromName: "Ada Lovelace", signature: "" }), null);
  });

  it("empty signature with a client brand writes the real pair", () => {
    const m = signatureMismatch({ fromName: "Ada Lovelace", signature: "", clientBrand: "Acme Co" });
    assert.equal(m?.desired, "Ada Lovelace\nAcme Co");
    assert.ok(!/First Last|client brand/.test(m!.reason));
  });

  it("a foreign client's brand is replaced with this client's brand", () => {
    const m = signatureMismatch({
      fromName: "Ada Lovelace",
      signature: "Ada Lovelace\nOther Brand Inc",
      clientBrand: "Acme Co",
      otherClientBrands: ["Acme Co", "Other Brand Inc"],
    });
    assert.equal(m?.desired, "Ada Lovelace\nAcme Co");
  });

  it("strips the (Person) suffix from the client display name and puts the text in the payload", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [{ id: 100, name: "Some Campaign", status: "ACTIVE", clientId: 10 }],
        accounts: [seat({ id: 1, email: "a@x.test", signature: "" })],
        clients: [{ id: 10, name: "Jane Doe", logo: "Acme Co" }],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
    });
    const writes = result.intended.filter((a) => a.kind === "signature_write");
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.payload.signature, "Ada Lovelace\nAcme Co");
    assert.equal(writes[0]!.executed, false);
  });
});

describe("D298 findings dedupe + per-stage scope", () => {
  const dup: Finding = { kind: "duplicate_canary_test", campaignId: 1, detail: "3 Canary copy tests for #1 (want 1)" };
  it("dedupes identical rows", () => {
    assert.equal(dedupeFindings([dup, { ...dup }, { ...dup, campaignId: 2 }]).length, 2);
  });
  it("staff and isolation replace only their own kinds, so rows never multiply", async () => {
    const store = new MemoryStore();
    const iso = ["duplicate_canary_test", "missing_canary"];
    for (let i = 0; i < 5; i += 1) {
      await store.replaceFindingsInScope({ only: iso }, [dup, dup, { kind: "missing_canary", campaignId: 1, detail: "x" }]);
      await store.replaceFindingsInScope({ except: iso }, [{ kind: "understaffed", campaignId: 1, detail: "y" }, dup]);
    }
    const rows = await store.listFindings();
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((r) => r.kind === "duplicate_canary_test").length, 1);
  });
});

describe("D298 InboxKit reader", () => {
  it("lists via POST /v1/api/mailboxes/list with the workspace header", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const post = (async (url: string, body: unknown, headers: Record<string, string> = {}) => {
      calls.push({ url, body, headers });
      if (url.endsWith("/workspaces/list")) return { result: [{ uid: "ws1" }] };
      return { result: { items: [{ username: "a", domain_name: "x.test", status: "Active" }] } };
    }) as unknown as typeof import("./clients/http.js").postJson;
    const reader = new InboxkitReader("k", undefined, post);
    const rows = await reader.listMailboxes();
    assert.equal(rows[0]?.email, "a@x.test");
    const list = calls.find((c) => c.url.endsWith("/v1/api/mailboxes/list"));
    assert.equal(list?.headers["X-Workspace-Id"], "ws1");
    assert.ok(!calls.some((c) => /\/v1\/mailboxes$/.test(c.url)));
  });
});

describe("D298 isolation stage budgets", () => {
  it("budgetSignal aborts at its budget", async () => {
    const b = budgetSignal(undefined, 10);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(b.signal.aborted, true);
    b.dispose();
  });
});
