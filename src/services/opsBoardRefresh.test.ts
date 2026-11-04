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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
