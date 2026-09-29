import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import { StateStore } from "../state/store.js";
import { Min40TopUpService } from "./min40TopUp.js";

function stateFile(): string {
  return `/tmp/min40-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

const warmedAt = "2026-01-01T00:00:00Z";

describe("Min40TopUpService (D205)", () => {
  it("auto-allows BCP and attaches exclusive warmed generics without a Slack card", async () => {
    const attached: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const slackCalls: string[] = [];
    const state = new StateStore(stateFile());
    await state.load();
    state.upsertPoolMailbox({
      email: "spare@crosslaunchco.com",
      domain: "crosslaunchco.com",
      platform: "GOOGLE",
      smartleadAccountId: 900,
      firstName: "Harmony",
      lastName: "Norris",
      status: "available",
      warmedAt,
    });
    const named = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i,
      from_email: `n${i}@boldercyperpartner.com`,
      client_id: 542838,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      campaign_ids: [10],
    }));
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
          attached.push([id, ids]);
        },
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          updates.push({ id, fields });
        },
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      {
        send: async (text: string) => {
          slackCalls.push(text);
        },
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: new Date("2026-09-29T15:00:00Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [
          { id: 10, name: "BCP No Team", status: "ACTIVE", client_id: 542838 },
        ],
        accounts: [
          ...named,
          {
            id: 900,
            from_email: "spare@crosslaunchco.com",
            from_name: "Harmony Norris",
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [],
          },
        ],
      },
    });
    assert.equal(attached.length, 1);
    assert.deepEqual(attached[0], [10, [900]]);
    assert.equal(updates[0]?.fields.client_id, 542838);
    assert.match(String(updates[0]?.fields.signature), /Bolder Cyber Partners/);
    assert.equal(result.assigned.length, 1);
    assert.equal(slackCalls.length, 0);
    assert.equal(result.asked.length, 0);
  });

  it("queues a Slack ask for a named client that is not auto-allow", async () => {
    const batches: Array<{ campaigns: Array<{ id: number }> }> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const named = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      from_email: `n${i}@other.com`,
      client_id: 999001,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      campaign_ids: [44],
    }));
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {} as unknown as SmartleadClient,
      {
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async (details: { campaigns: Array<{ id: number }> }) => {
          batches.push(details);
          return { channel: "C1", ts: "1.2" };
        },
      } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: new Date("2026-09-29T15:00:00Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 999001, name: "Other Co", logo: "Other Co" }],
        campaigns: [{ id: 44, name: "Other live", status: "ACTIVE", client_id: 999001 }],
        accounts: named,
      },
    });
    assert.equal(result.assigned.length, 0);
    assert.equal(result.asked.length, 1);
    assert.equal(batches.length, 0);
    const pending = state.listIsolationActions().filter((row) => row.kind === "generic_backfill");
    assert.equal(pending.length, 1);
  });

  it("never writes POD tags", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./min40TopUp.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(src, /updateMailboxTags/);
    assert.match(src, /Never retag named seats/);
  });
});
