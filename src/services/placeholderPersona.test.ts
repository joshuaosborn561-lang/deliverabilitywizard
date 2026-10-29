import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import { onWeekCohort } from "../lib/restCohort.js";
import { StateStore } from "../state/store.js";
import { Min40TopUpService } from "./min40TopUp.js";

function stateFile(): string {
  return `/tmp/placeholder-persona-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

const warmedAt = "2026-01-01T00:00:00Z";

/**
 * "Other Co" POD with 20 named on-week seats + 25 free generic seats. The
 * short-campaign fill assigns generics; each case varies what name the
 * pool row and the live Smartlead mailbox carry.
 */
async function runFill(opts: {
  poolFirst: string;
  poolLast: string;
  liveFromName: string | undefined;
  poolRows: boolean;
}) {
  const attached: number[] = [];
  const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
  const now = new Date("2026-10-05T15:00:00.000Z");
  const onWeek = onWeekCohort(now);
  const state = new StateStore(stateFile());
  await state.load();
  if (opts.poolRows) {
    for (let i = 0; i < 25; i++) {
      state.upsertPoolMailbox({
        email: `spare${i}@crosslaunchco.com`,
        domain: "crosslaunchco.com",
        platform: "GOOGLE",
        smartleadAccountId: 900 + i,
        firstName: opts.poolFirst,
        lastName: opts.poolLast,
        status: "available",
        warmedAt,
      });
    }
  }
  const named = Array.from({ length: 20 }, (_, i) => ({
    id: 400 + i,
    from_email: `o${i}@other.com`,
    client_id: 999001,
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    tags: [{ tag_name: `POD-${onWeek}` }],
    campaign_ids: [44],
    created_at: "2026-01-01T00:00:00.000Z",
  }));
  const pool = Array.from({ length: 25 }, (_, i) => ({
    id: 900 + i,
    from_email: `spare${i}@crosslaunchco.com`,
    ...(opts.liveFromName !== undefined ? { from_name: opts.liveFromName } : {}),
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    tags: [{ tag_name: "GENERIC" }],
    campaign_ids: [],
  }));
  const service = new Min40TopUpService(
    loadConfig({ DRY_RUN: "false" }),
    {
      addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
        if (id === 44) attached.push(...ids);
      },
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    } as unknown as SmartleadClient,
    { send: async () => undefined, notifyIsolationAction: async () => undefined } as unknown as SlackClient,
    state,
  );
  const result = await service.run({
    dryRun: false,
    now,
    inventory: {
      fetchedAt: Date.now(),
      clients: [{ id: 999001, name: "Other Co", logo: "Other Co" }],
      campaigns: [{ id: 44, name: "Other live", status: "ACTIVE", client_id: 999001 }],
      accounts: [...named, ...pool],
    },
  });
  return { result, attached, updates };
}

function nameWrites(updates: Array<{ id: number; fields: Record<string, unknown> }>) {
  return updates.filter((row) => "from_name" in row.fields || "signature" in row.fields);
}

describe("real-persona rule — min40-topup never invents a name", () => {
  it("pool row 'Pool'/'User' + live 'Pool User': sends as the company, never 'Pool User'", async () => {
    const { attached, updates } = await runFill({
      poolFirst: "Pool",
      poolLast: "User",
      liveFromName: "Pool User",
      poolRows: true,
    });
    assert.ok(attached.length > 0, "the assign is not refused");
    const writes = nameWrites(updates);
    assert.ok(writes.length > 0);
    for (const row of writes) {
      assert.equal(row.fields.from_name, "Other Co");
      assert.equal(row.fields.signature, "Other Co");
    }
  });

  it("no pool row and a blank live from_name: sends as the company", async () => {
    const { attached, updates } = await runFill({
      poolFirst: "",
      poolLast: "",
      liveFromName: undefined,
      poolRows: false,
    });
    assert.ok(attached.length > 0);
    for (const row of nameWrites(updates)) {
      assert.equal(row.fields.from_name, "Other Co");
      assert.equal(row.fields.signature, "Other Co");
    }
  });

  it("no pool row, real live from_name: keeps that persona, never 'Pool User'", async () => {
    const { attached, updates } = await runFill({
      poolFirst: "",
      poolLast: "",
      liveFromName: "Wilhelmina Oldfield",
      poolRows: false,
    });
    assert.ok(attached.length > 0, "a seat with a real persona is still assigned");
    const writes = nameWrites(updates);
    assert.ok(writes.length > 0);
    for (const row of writes) {
      assert.equal(row.fields.from_name, "Wilhelmina Oldfield");
      assert.equal(row.fields.signature, "Wilhelmina Oldfield\nOther Co");
    }
  });

  it("no write anywhere contains a placeholder name or signature", async () => {
    for (const live of ["Pool User", "Generic Box", undefined, "wilhelmina"]) {
      const { updates } = await runFill({
        poolFirst: "Pool",
        poolLast: "User",
        liveFromName: live,
        poolRows: true,
      });
      for (const row of nameWrites(updates)) {
        const text = `${String(row.fields.from_name)}|${String(row.fields.signature)}`;
        assert.ok(!/pool|user|generic|\bbox\b/i.test(text), text);
      }
    }
  });

  it("named pool row wins over a stale live name", async () => {
    const { updates } = await runFill({
      poolFirst: "Alicia",
      poolLast: "Sheridan",
      liveFromName: "Pool User",
      poolRows: true,
    });
    const writes = nameWrites(updates);
    assert.ok(writes.length > 0);
    for (const row of writes) {
      assert.equal(row.fields.from_name, "Alicia Sheridan");
      assert.equal(row.fields.signature, "Alicia Sheridan\nOther Co");
    }
  });
});

describe("real-persona rule — no placeholder fallback literals in source", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  // Canary boxes never sit on client campaigns (D54/D55): exempt.
  const EXEMPT = new Set([
    "src/services/copyCanary.ts",
    "src/services/copyCanaryBuy.ts",
    "src/services/canaryShell.ts",
    "src/lib/personaName.ts",
  ]);
  it('no `|| "Pool"` / `|| "User"` / "Pool User" fallback in non-test source', () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      if (EXEMPT.has(file)) continue;
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/\|\|\s*"Pool"|\|\|\s*"User"|\?\?\s*"Pool"|\?\?\s*"User"|"Pool User"|"Mailbox Box"/.test(text)) {
        offenders.push(file);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
