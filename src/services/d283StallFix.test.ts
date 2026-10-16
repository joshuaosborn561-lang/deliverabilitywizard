import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import { GENERIC_ASSIGN_REASON_POWERGRYD } from "../lib/genericPool.js";
import { CORNERSTONE_CLIENT_ID, POWERGRYD_CLIENT_ID } from "../lib/namedClientIds.js";
import { onWeekCohort } from "../lib/restCohort.js";
import { StateStore } from "../state/store.js";
import { Min40TopUpService } from "./min40TopUp.js";
import { GenericCleanupService } from "./genericCleanup.js";
import { OneClientMembershipService } from "./oneClientMembership.js";
import type { InventorySnapshot } from "./inventory.js";

const NOW = new Date("2026-10-16T22:40:00.000Z");
const ON_WEEK = onWeekCohort(NOW);

function slack(): SlackClient {
  return {
    send: async () => undefined,
    notifyIsolationAction: async () => undefined,
  } as unknown as SlackClient;
}

function stateFile(): string {
  return `/tmp/d283-stall-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe("D283 stall fix — book-only guards, no PowerGRYD pool walk", () => {
  it("min40 / one-client / generic-cleanup finish fast on a production-sized D283 book", async () => {
    const pgCampaigns = Array.from({ length: 8 }, (_, i) => ({
      id: 8000 + i,
      name: `PowerGRYD ${i}`,
      status: "ACTIVE" as const,
      client_id: POWERGRYD_CLIENT_ID,
    }));
    const teCampaigns = Array.from({ length: 4 }, (_, i) => ({
      id: 9000 + i,
      name: `TechEvo ${i}`,
      status: "ACTIVE" as const,
      client_id: 521881,
    }));
    const teNamed = Array.from({ length: 40 }, (_, i) => ({
      id: 500 + i,
      from_email: `te${i}@techevolution.com`,
      client_id: 521881,
      type: i % 2 === 0 ? "GMAIL" : "OUTLOOK",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: `POD-${ON_WEEK}` }],
      campaign_ids: teCampaigns.map((row) => row.id),
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    const pgNamedWarming = Array.from({ length: 12 }, (_, i) => ({
      id: 600 + i,
      from_email: `pg${i}@powergryd.com`,
      client_id: POWERGRYD_CLIENT_ID,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: `POD-${ON_WEEK}` }],
      campaign_ids: [] as number[],
      created_at: "2026-10-10T00:00:00.000Z",
    }));
    const held = Array.from({ length: 73 }, (_, i) => ({
      id: 700 + i,
      from_email: `held${i}@cornerstoneearthworksmy.info`,
      client_id: CORNERSTONE_CLIENT_ID,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "HOLD-UNTIL-2026-12-31" }, { tag_name: `POD-${ON_WEEK}` }],
      campaign_ids: [] as number[],
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    const freed = Array.from({ length: 85 }, (_, i) => ({
      id: 21592200 + i,
      from_email: `freed${i}@getoutreachdesk.info`,
      from_name: `Freed ${i}`,
      client_id: null as number | null,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "GENERIC" }, { tag_name: `POD-${ON_WEEK}` }],
      campaign_ids: i < 10 ? [8000] : ([] as number[]),
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    const pool = Array.from({ length: 400 }, (_, i) => ({
      id: 300_000 + i,
      from_email: `g${i}@crosslaunchco.com`,
      from_name: `Pool ${i}`,
      client_id: null as number | null,
      type: i % 2 === 0 ? "GMAIL" : "OUTLOOK",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "GENERIC" }],
      campaign_ids: [] as number[],
      created_at: "2026-01-01T00:00:00.000Z",
    }));

    const state = new StateStore(stateFile());
    await state.load();
    for (const row of freed) {
      state.upsertPoolMailbox({
        email: row.from_email,
        domain: "getoutreachdesk.info",
        platform: "GOOGLE",
        smartleadAccountId: row.id,
        firstName: "Freed",
        lastName: String(row.id),
        status: "assigned",
        assignedClientId: POWERGRYD_CLIENT_ID,
        assignedClientName: "PowerGRYD",
        warmedAt: "2026-01-01T00:00:00Z",
      });
      state.upsertGenericSeat({
        email: row.from_email,
        slAccountId: row.id,
        provider: "GOOGLE",
        warmReadyAt: "2026-01-01T00:00:00Z",
        assignedClientId: POWERGRYD_CLIENT_ID,
        assignedCampaignIds: row.campaign_ids,
        assignedPod: ON_WEEK,
        assignedAt: "2026-09-01T00:00:00Z",
        reason: GENERIC_ASSIGN_REASON_POWERGRYD,
        releasedAt: null,
        releaseHistory: [],
        staffableWeight: 1,
      });
    }
    for (const row of pool) {
      state.upsertPoolMailbox({
        email: row.from_email,
        domain: "crosslaunchco.com",
        platform: row.type === "GMAIL" ? "GOOGLE" : "MICROSOFT",
        smartleadAccountId: row.id,
        firstName: "Pool",
        lastName: String(row.id),
        status: "available",
        warmedAt: "2026-01-01T00:00:00Z",
      });
      state.ensureGenericSeat({
        email: row.from_email,
        slAccountId: row.id,
        provider: row.type === "GMAIL" ? "GOOGLE" : "MICROSOFT",
        warmReadyAt: "2026-01-01T00:00:00Z",
      });
    }

    const attached: Array<[number, number[]]> = [];
    let getEmailAccountCalls = 0;
    const inventory: InventorySnapshot = {
      fetchedAt: Date.now(),
      clients: [
        { id: POWERGRYD_CLIENT_ID, name: "PowerGRYD", logo: "PowerGRYD" },
        { id: 521881, name: "TechEvo", logo: "TechEvolution" },
        { id: CORNERSTONE_CLIENT_ID, name: "CornerStone", logo: "CornerStone Earthworks" },
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
      ],
      campaigns: [
        ...pgCampaigns,
        ...teCampaigns,
        { id: 5486, name: "Goliath live", status: "ACTIVE", client_id: 548611 },
      ],
      accounts: [...teNamed, ...pgNamedWarming, ...held, ...freed, ...pool],
    };
    const smartlead = {
      addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
        attached.push([id, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      getEmailAccount: async () => {
        getEmailAccountCalls += 1;
        throw new Error("D283 guards must not GET a seat");
      },
      ensureTag: async (name: string) => ({ id: 99, name }),
      assignTags: async () => undefined,
    } as unknown as SmartleadClient;

    let lastBeat = Date.now();
    let ticks = 0;
    let maxGap = 0;
    const timer = setInterval(() => {
      const nowMs = Date.now();
      maxGap = Math.max(maxGap, nowMs - lastBeat);
      lastBeat = nowMs;
      ticks += 1;
    }, 15);
    timer.unref?.();

    const started = Date.now();
    const one = await new OneClientMembershipService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      state,
    ).run({ dryRun: false, inventory });
    const min40 = await new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      slack(),
      state,
    ).run({ dryRun: false, inventory, now: NOW });
    const cleanup = await new GenericCleanupService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      state,
    ).run({ dryRun: false, inventory, now: NOW });
    const elapsed = Date.now() - started;
    clearInterval(timer);

    const heldIds = new Set(held.map((row) => row.id));
    const freedIds = new Set(freed.map((row) => row.id));
    const pgCampaignIds = new Set(pgCampaigns.map((row) => row.id));
    assert.equal(getEmailAccountCalls, 0, "no per-seat Smartlead GET");
    assert.equal(
      attached.some((row) => row[1].some((id) => heldIds.has(id))),
      false,
      `HOLD-UNTIL must not attach: ${JSON.stringify(attached)}`,
    );
    assert.equal(
      attached.some(
        (row) =>
          pgCampaignIds.has(row[0]) &&
          row[1].some((id) => freedIds.has(id) || id >= 300_000),
      ),
      false,
      `no generics onto PowerGRYD: ${JSON.stringify(attached)}`,
    );
    assert.equal(
      attached.some((row) => row[0] === 5486 && row[1].some((id) => freedIds.has(id))),
      false,
      `freed seats must not dump onto Goliath: ${JSON.stringify(attached)} ${JSON.stringify(one)}`,
    );
    assert.ok(ticks > 0, `event loop must breathe (ticks=${ticks} elapsed=${elapsed}ms)`);
    assert.ok(
      maxGap < 800,
      `largest event-loop gap was ${maxGap}ms — D283 walks must yield`,
    );
    assert.ok(
      elapsed < 10_000,
      `D283 loops on ${inventory.accounts.length} seats took ${elapsed}ms cleanup=${JSON.stringify({ examined: cleanup.examined, cleared: cleanup.cleared.length })} min40 assigned=${min40.assigned.length}`,
    );
  });
});
