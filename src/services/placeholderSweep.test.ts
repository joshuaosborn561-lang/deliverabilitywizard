import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { emptyGenericSeat } from "../lib/genericPool.js";
import { returnGenericToUntaggedPool } from "../lib/genericReturn.js";
import { mailboxSignatureMismatch } from "../lib/mailboxSignature.js";
import { StateStore } from "../state/store.js";
import type { InventorySnapshot } from "./inventory.js";
import { PlaceholderSweepService } from "./placeholderSweep.js";

function stateFile(): string {
  return `/tmp/placeholder-sweep-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

const CLIENT = { id: 574020, name: "Emcor", logo: "Emcor" };

function inventory(accounts: Array<Record<string, unknown>>, status = "ACTIVE"): InventorySnapshot {
  return {
    fetchedAt: Date.now(),
    clients: [CLIENT],
    campaigns: [{ id: 1, name: "EMCOR A", status, client_id: CLIENT.id }],
    accounts,
  } as unknown as InventorySnapshot;
}

function seat(id: number, from_name: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    id,
    from_email: `seat${id}@example.info`,
    ...(from_name !== undefined ? { from_name } : {}),
    signature: from_name ? `${from_name}\nEmcor` : "",
    client_id: CLIENT.id,
    campaign_ids: [1],
    tags: [{ tag_name: "GENERIC" }],
    ...extra,
  };
}

async function run(
  accounts: Array<Record<string, unknown>>,
  opts: { writeEnabled?: boolean; status?: string; persona?: [string, string] } = {},
) {
  const state = new StateStore(stateFile());
  await state.load();
  if (opts.persona) {
    state.upsertPoolMailbox({
      email: "seat1@example.info",
      domain: "example.info",
      platform: "GOOGLE",
      smartleadAccountId: 1,
      firstName: opts.persona[0],
      lastName: opts.persona[1],
      status: "assigned",
    });
  }
  const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
  const service = new PlaceholderSweepService(
    loadConfig({}),
    {
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        writes.push({ id, fields });
      },
    } as never,
    state,
  );
  const result = await service.run({
    inventory: inventory(accounts, opts.status),
    writeEnabled: opts.writeEnabled,
  });
  return { result, writes };
}

describe("D321 placeholder sweep", () => {
  it("write flag is OFF by default in config", () => {
    const config = loadConfig({});
    assert.equal(config.placeholderSweepWriteEnabled, false);
    assert.equal(config.enablePlaceholderSweep, false);
  });

  it("flag OFF: finds placeholder seats, writes nothing", async () => {
    const { result, writes } = await run([seat(1, "Pool User"), seat(2, "Wilhelmina Oldfield")]);
    assert.equal(result.placeholders, 1);
    assert.equal(result.pending, 1);
    assert.equal(result.replaced, 0);
    assert.equal(writes.length, 0);
  });

  it("flag ON: no persona -> sends as the company; name + signature only, never unlink", async () => {
    const { result, writes } = await run([seat(1, "Pool User")], { writeEnabled: true });
    assert.equal(result.replaced, 1);
    assert.deepEqual(writes, [{ id: 1, fields: { from_name: "Emcor", signature: "Emcor" } }]);
  });

  it("flag ON: a persona on the pool row is restored", async () => {
    const { writes } = await run([seat(1, "Pool User")], {
      writeEnabled: true,
      persona: ["Wilhelmina", "Oldfield"],
    });
    assert.deepEqual(writes, [
      { id: 1, fields: { from_name: "Wilhelmina Oldfield", signature: "Wilhelmina Oldfield\nEmcor" } },
    ]);
  });

  it("blank from_name is replaced too; a real name and a company-named seat are left alone", async () => {
    const { result, writes } = await run(
      [seat(1, undefined), seat(2, "Alicia Sheridan"), seat(3, "Emcor")],
      { writeEnabled: true },
    );
    assert.equal(result.placeholders, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.id, 1);
  });

  it("a placeholder name line in the signature alone is fixed", async () => {
    const acct = { ...seat(2, "Alicia Sheridan"), signature: "Pool User\nEmcor" };
    const { writes } = await run([acct], { writeEnabled: true });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.fields.from_name, "Alicia Sheridan");
    assert.equal(writes[0]!.fields.signature, "Alicia Sheridan\nEmcor");
  });

  it("leaves STOPPED campaigns, Gabe VM seats and seats off every campaign alone", async () => {
    const stopped = await run([seat(1, "Pool User")], { writeEnabled: true, status: "STOPPED" });
    assert.equal(stopped.writes.length, 0);
    const gabe = await run(
      [seat(1, "Pool User", { tags: [{ tag_name: "GABE-VM-RESERVED" }] })],
      { writeEnabled: true },
    );
    assert.equal(gabe.writes.length, 0);
    const off = await run([seat(1, "Pool User", { campaign_ids: [] })], { writeEnabled: true });
    assert.equal(off.result.examined, 0);
  });

  it("caps writes per run", async () => {
    const many = Array.from({ length: 70 }, (_, i) => seat(100 + i, "Pool User"));
    const { result, writes } = await run(many, { writeEnabled: true });
    assert.equal(writes.length, 60);
    assert.equal(result.pending, 10);
  });

  it("source: the sweep never unlinks and never touches campaign status", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./placeholderSweep.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /removeEmailAccountsFromCampaign|updateCampaignStatus|\/status/);
  });
});

describe("D321 signature check + release", () => {
  it("a placeholder sender name is a mismatch, not 'in sync'", () => {
    const text = mailboxSignatureMismatch({
      fromName: "Pool User",
      signature: "Pool User\nEmcor",
      clientBrand: "Emcor",
    });
    assert.match(String(text), /no real sender name/);
    assert.match(
      String(mailboxSignatureMismatch({ fromName: "", signature: "", clientBrand: "Emcor" })),
      /blank/,
    );
    assert.equal(
      mailboxSignatureMismatch({ fromName: "Emcor", signature: "Emcor", clientBrand: "Emcor" }),
      null,
    );
  });

  it("release restores the persona over a placeholder from_name", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    state.upsertGenericSeat(
      emptyGenericSeat("ada@getintroduced.info", {
        slAccountId: 9,
        assignedClientId: 77,
        assignedPod: "A",
        assignedAt: "2026-10-01T00:00:00.000Z",
        reason: "pod_top_up",
      }),
    );
    state.upsertPoolMailbox({
      email: "ada@getintroduced.info",
      domain: "getintroduced.info",
      platform: "GOOGLE",
      smartleadAccountId: 9,
      firstName: "Ada",
      lastName: "Lovelace",
      status: "assigned",
    });
    const writes: Array<Record<string, unknown>> = [];
    const account = {
      id: 9,
      from_email: "ada@getintroduced.info",
      from_name: "Pool User",
      client_id: 77,
      signature: "Pool User\nTechEvo",
      tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
    };
    await returnGenericToUntaggedPool({
      smartlead: {
        updateEmailAccount: async (_id, fields) => {
          writes.push(fields);
        },
      },
      state,
      account: account as never,
      email: "ada@getintroduced.info",
      reason: "surplus_return",
      now: new Date("2026-10-04T12:00:00.000Z"),
    });
    assert.deepEqual(writes, [{ client_id: null, signature: "", from_name: "Ada Lovelace" }]);
  });
});
