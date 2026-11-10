import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpsBoardRefresh } from "./opsBoardRefresh.js";
import type { CallingSnapshot } from "../ops/callingBoard.js";
import type { LinkedInSnapshot } from "../ops/linkedinBoard.js";
import type { WatchdogSnapshot } from "../ops/watchdogBoard.js";
import type { StateStore } from "../state/store.js";

describe("ops board refresh", () => {
  it("reads dated sends and remaining leads, and never stores a HeyReach key", async () => {
    const secret = "heyreach-test-key-do-not-store-anywhere";
    const saved: {
      watchdog: WatchdogSnapshot | null;
      calling: CallingSnapshot | null;
      linkedin: LinkedInSnapshot | null;
    } = { watchdog: null, calling: null, linkedin: null };
    const state = {
      replaceOpsWatchdog(snapshot: WatchdogSnapshot) {
        saved.watchdog = snapshot;
      },
      replaceOpsCalling(snapshot: CallingSnapshot) {
        saved.calling = snapshot;
      },
      replaceOpsLinkedin(snapshot: LinkedInSnapshot) {
        saved.linkedin = snapshot;
      },
      async save() {},
    } as unknown as StateStore;
    const now = new Date("2026-11-04T18:00:00.000Z");
    const refresh = new OpsBoardRefresh({
      state,
      campaigns: () => [
        { id: 11, name: "Vector outbound", status: "ACTIVE", client_id: 7 },
        { id: 12, name: "Canary shell #1", status: "ACTIVE", client_id: 7 },
      ],
      clients: () => [{ id: 7, name: "Vector", email: "ops@example.com" }],
      analyticsByDate: async () => ({
        data: [{ date: "2026-11-04", sent_count: 80 }],
        sent_count: 9000,
      }),
      analytics: async () => ({
        campaign_lead_stats: { total: 100, notStarted: 40, inprogress: 15 },
        sent_count: 9000,
      }),
      supabase: () => ({ url: "https://example.supabase.co", serviceRoleKey: "service-role-test" }),
      slackToken: () => "slack-test-token",
      gabeDialsTarget: () => null,
      now: () => now,
      sleep: async () => {},
      fetchImpl: async (input, init) => {
        const url = String(input);
        const header = String((init?.headers as Record<string, string> | undefined)?.["X-API-KEY"] ?? "");
        if (url.startsWith("https://api.heyreach.io/")) assert.equal(header, secret);
        else assert.equal(header, "");
        if (url.includes("/rpc/ops_calling_snapshot")) {
          return json({
            gabeDialsYesterday: 4,
            clients: [{
              clientName: "Vector",
              queueContacts: 12,
              queues: 1,
              queuesFull: 0,
              missingEmail: 2,
              queuesCalled3: 0,
              voicemailsYesterday: 3,
              emailsYesterday: 3,
              mismatchReason: null,
              routerErrors: 0,
            }],
            numbers: [],
            suppression: { dnc: 1, dncStillQueued: 0, unsub: 1, unsubStillQueued: 0, unsubStillEmailed: 0 },
            tagging: { voicemailCalls: 3, voicemailTagged: 3, untaggedOver30s: 0 },
          });
        }
        if (url.includes("/rpc/ops_heyreach_workspaces")) {
          return json([
            { slug: "vector", secret },
            { slug: "heyreach_master", secret: "master-key-must-not-appear" },
          ]);
        }
        if (url.includes("campaign/GetAll")) {
          return json({ items: [{ id: 5, name: "Vector lane", status: "IN_PROGRESS", progressStats: { totalUsersPending: 8, totalUsersInProgress: 2 } }] });
        }
        if (url.includes("GetOverallStats")) {
          const error = new Response("nope", { status: 401 });
          return error;
        }
        if (url.includes("conversations.history")) {
          return json({
            ok: true,
            messages: [{ text: "Lead Name said hello about the offer", user: "U1" }],
          });
        }
        return json({});
      },
    });
    const result = await refresh.run(now);
    assert.equal(result.watchdogClients, 1);
    assert.equal(saved.watchdog?.clients[0]?.sendsToday, 80);
    assert.equal(saved.watchdog?.clients[0]?.leadsLeft, 55);
    assert.equal(saved.watchdog?.source, "campaign-watchdog-analytics");
    assert.equal(saved.calling?.gabeDialsYesterday, 4);
    assert.equal(saved.calling?.gabeDialsTarget, null);
    assert.equal(saved.linkedin?.repliesToday, 1);
    assert.equal(saved.linkedin?.clients.find((row) => row.clientName === "Vector")?.keyState, "invalid");
    assert.equal(saved.linkedin?.clients.some((row) => row.clientName === "PowerGRYD" && row.keyState === "missing"), true);
    const dumped = JSON.stringify(saved);
    assert.equal(dumped.includes(secret), false);
    assert.equal(dumped.includes("master-key-must-not-appear"), false);
    assert.equal(dumped.includes("Lead Name"), false);
    assert.equal(dumped.includes("said hello"), false);
    assert.equal(dumped.includes("@"), false);
  });
});

describe("ops board watchdog reading", () => {
  const now = new Date("2026-11-10T19:00:00.000Z");
  const lead = (notStarted: number, inprogress: number) => ({
    total_count: String((notStarted + inprogress) * 2),
    drafted_count: String(notStarted * 2 + inprogress),
    campaign_lead_stats: { total: notStarted + inprogress, notStarted, inprogress, completed: 0 },
  });

  function harness(opts: {
    prior?: WatchdogSnapshot | null;
    campaigns: Array<{ id: number; name: string; status: string; client_id: number | null }>;
    clients?: Array<{ id: number; name: string; logo?: string }>;
    byDate: (id: number, day: string, signal: AbortSignal) => Promise<unknown>;
    analytics: (id: number, signal: AbortSignal) => Promise<unknown>;
    budgetMs?: number;
  }) {
    const saved: { watchdog: WatchdogSnapshot | null; replaced: number } = {
      watchdog: opts.prior ?? null,
      replaced: 0,
    };
    const state = {
      getOpsBoard: () => ({ watchdog: saved.watchdog }),
      replaceOpsWatchdog(snapshot: WatchdogSnapshot) {
        saved.watchdog = snapshot;
        saved.replaced += 1;
      },
      replaceOpsCalling() {},
      replaceOpsLinkedin() {},
      async save() {},
    } as unknown as StateStore;
    const refresh = new OpsBoardRefresh({
      state,
      campaigns: () => opts.campaigns,
      clients: () => (opts.clients ?? []) as never,
      analyticsByDate: opts.byDate,
      analytics: opts.analytics,
      supabase: () => null,
      slackToken: () => "",
      gabeDialsTarget: () => null,
      now: () => now,
      sleep: async () => {},
      budgetMs: opts.budgetMs,
      fetchImpl: async () => json({}),
    });
    return { refresh, saved };
  }

  it("asks Smartlead for the Eastern send day", async () => {
    const days: string[] = [];
    const late = new Date("2026-11-11T05:30:00.000Z"); // 23:30 CT, 00:30 ET
    const { refresh } = harness({
      campaigns: [{ id: 1, name: "BPLTG IT DM", status: "ACTIVE", client_id: 602897 }],
      clients: [{ id: 602897, name: "BPLTG", logo: "BPLTG" }],
      byDate: async (_id, day) => {
        days.push(day);
        return { sent_count: "0" };
      },
      analytics: async () => lead(10, 0),
    });
    await refresh.run(late);
    assert.deepEqual(days, ["2026-11-11"]);
  });

  it("a 429 on one campaign keeps its last reading and marks the client partial", async () => {
    const prior: WatchdogSnapshot = {
      updatedAt: "2026-11-10T18:00:00.000Z",
      partial: false,
      day: "2026-11-10",
      paceTarget: 1200,
      source: "campaign-watchdog-analytics",
      clients: [],
      campaigns: [
        { id: 2, clientId: "602897", day: "2026-11-10", sendsToday: 400, leadsLeft: 900, readAt: "2026-11-10T18:00:00.000Z" },
      ],
    };
    const { refresh, saved } = harness({
      prior,
      campaigns: [
        { id: 1, name: "BPLTG IT DM 11 to 50", status: "ACTIVE", client_id: 602897 },
        { id: 2, name: "BPLTG IT DM 51 to 100", status: "ACTIVE", client_id: 602897 },
        { id: 3, name: "BPLTG IT DM Spa", status: "ACTIVE", client_id: 602897 },
      ],
      clients: [{ id: 602897, name: "BPLTG", logo: "BPLTG" }],
      byDate: async (id) => {
        if (id !== 1) throw new Error("Too Many Requests (HTTP 429)");
        return { sent_count: "31" };
      },
      analytics: async () => lead(76, 31),
    });
    await refresh.run(now);
    const client = saved.watchdog?.clients[0];
    assert.equal(client?.campaigns, 3);
    // Campaign 1 fresh (31 sends, 107 leads) + campaign 2 carried (400, 900).
    assert.equal(client?.sendsToday, 431);
    assert.equal(client?.sendsRead, 2);
    assert.equal(client?.leadsLeft, 1007);
    assert.equal(client?.leadsRead, 2);
    assert.equal(saved.watchdog?.partial, true);
  });

  it("a pass starved past its budget does not replace the board with nothing", async () => {
    const prior: WatchdogSnapshot = {
      updatedAt: "2026-11-10T17:00:00.000Z",
      partial: false,
      day: "2026-11-10",
      paceTarget: 1200,
      source: "campaign-watchdog-analytics",
      clients: [{ clientId: "597119", clientName: "Vector Energy Group", sendsToday: 300, leadsLeft: 8000 }],
      campaigns: [
        { id: 7, clientId: "597119", day: "2026-11-10", sendsToday: 300, leadsLeft: 8000, readAt: "2026-11-10T17:00:00.000Z" },
      ],
    };
    const { refresh, saved } = harness({
      prior,
      budgetMs: 20,
      campaigns: [{ id: 7, name: "Vector lane", status: "ACTIVE", client_id: 597119 }],
      clients: [{ id: 597119, name: "Vector Energy Group" }],
      // Parked in the shared limiter queue: never settles, ignores abort.
      byDate: () => new Promise(() => undefined),
      analytics: () => new Promise(() => undefined),
    });
    const result = await refresh.run(now);
    assert.equal(result.watchdogClients, 1);
    assert.equal(saved.watchdog?.clients[0]?.sendsToday, 300);
    assert.equal(saved.watchdog?.clients[0]?.leadsLeft, 8000);
    assert.equal(saved.watchdog?.partial, true);
  });

  it("does not carry yesterday's sends into today, but does carry recent leads", async () => {
    const prior: WatchdogSnapshot = {
      updatedAt: "2026-11-10T03:00:00.000Z",
      partial: false,
      day: "2026-11-09",
      paceTarget: 1200,
      source: "campaign-watchdog-analytics",
      clients: [],
      campaigns: [
        { id: 7, clientId: "597119", day: "2026-11-09", sendsToday: 640, leadsLeft: 8000, readAt: "2026-11-10T03:30:00.000Z" },
      ],
    };
    const { refresh, saved } = harness({
      prior,
      campaigns: [{ id: 7, name: "Vector lane", status: "ACTIVE", client_id: 597119 }],
      clients: [{ id: 597119, name: "Vector Energy Group" }],
      byDate: async () => {
        throw new Error("HTTP 500");
      },
      analytics: async () => {
        throw new Error("HTTP 500");
      },
    });
    // 03:00 ET on Nov 10, 4.5h after the Nov 9 reading.
    await refresh.run(new Date("2026-11-10T08:00:00.000Z"));
    const client = saved.watchdog?.clients[0];
    assert.equal(client?.sendsRead, 0);
    assert.equal(client?.sendsToday, 0);
    assert.equal(client?.leadsLeft, 8000);
  });

  it("keeps the last board when the inventory book has no campaigns yet", async () => {
    const { refresh, saved } = harness({
      prior: null,
      campaigns: [],
      byDate: async () => ({}),
      analytics: async () => ({}),
    });
    const result = await refresh.run(now);
    assert.equal(result.watchdogClients, 0);
    assert.equal(saved.replaced, 0);
  });

  it("still counts a client's campaigns when the client list failed to load", async () => {
    const { refresh, saved } = harness({
      campaigns: [
        { id: 1, name: "Goliath Education PenTest", status: "ACTIVE", client_id: 548611 },
        { id: 2, name: "Goliath paused", status: "PAUSED", client_id: 548611 },
        { id: 3, name: "Unowned", status: "ACTIVE", client_id: null },
      ],
      clients: [],
      byDate: async () => ({ sent_count: "55" }),
      analytics: async () => lead(6000, 10),
    });
    await refresh.run(now);
    assert.equal(saved.watchdog?.clients.length, 1);
    assert.equal(saved.watchdog?.clients[0]?.clientName, "Client 548611");
    assert.equal(saved.watchdog?.clients[0]?.sendsToday, 55);
    assert.equal(saved.watchdog?.clients[0]?.leadsLeft, 6010);
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
