import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { podSwapSignal } from "../lib/podSwapProgress.js";
import { StateStore } from "../state/store.js";
import { ClientRestService } from "./clientRest.js";

/** Monday of ISO week 46: POD-A off, POD-B on. */
const WEEK_46 = new Date("2026-11-09T15:00:00Z");
const WARMED = "2025-01-01T00:00:00.000Z";
const FLOOR = 40;

/**
 * Pads keep the campaign at the floor except for the two off-week
 * seats. Removing those before the on-week seats land drops the
 * linked count under 40.
 */
function pads(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: 9000 + i,
    from_email: `pad-${i}@crosslaunchco.com`,
    campaign_ids: [1],
    created_at: WARMED,
    is_smtp_success: true,
    is_imap_success: true,
  }));
}

describe("D330 POD swap order and resume", () => {
  it("attaches the on-week pod before any detach and never drops under 40", async () => {
    const ops: string[] = [];
    const linked = new Set<number>([...pads(FLOOR - 2).map((row) => row.id as number), 1, 2]);
    let low = linked.size;
    const note = (): void => {
      if (linked.size < low) low = linked.size;
    };

    const state = new StateStore(
      `/tmp/client-rest-swap-order-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Parlay", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        ...pads(FLOOR - 2),
        {
          id: 1,
          from_email: "off-a@client.info",
          client_id: 9,
          campaign_ids: [1],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
          tags: [{ tag_name: "POD-A" }],
        },
        {
          id: 2,
          from_email: "off-b@client.info",
          client_id: 9,
          campaign_ids: [1],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
          tags: [{ tag_name: "POD-A" }],
        },
        {
          id: 101,
          from_email: "on-a@client.info",
          client_id: 9,
          campaign_ids: [],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
          tags: [{ tag_name: "POD-B" }],
        },
        {
          id: 102,
          from_email: "on-b@client.info",
          client_id: 9,
          campaign_ids: [],
          created_at: WARMED,
          is_smtp_success: true,
          is_imap_success: true,
          tags: [{ tag_name: "POD-B" }],
        },
      ],
      addEmailAccountsToCampaign: async (_campaignId: number, ids: number[]) => {
        ops.push(`add:${ids[0]}`);
        linked.add(ids[0]!);
        note();
      },
      removeEmailAccountsFromCampaign: async (_campaignId: number, ids: number[]) => {
        ops.push(`remove:${ids[0]}`);
        linked.delete(ids[0]!);
        note();
      },
    } as unknown as SmartleadClient;

    const service = new ClientRestService(
      loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const result = await service.run({ dryRun: false, now: WEEK_46 });
    const firstRemove = ops.findIndex((op) => op.startsWith("remove:"));
    const lastAdd = ops.findLastIndex((op) => op.startsWith("add:"));
    assert.ok(firstRemove > lastAdd, `adds must finish before removes, got ${ops.join(" ")}`);
    assert.ok(low >= FLOOR, `linked seats fell to ${low}, under the floor of ${FLOOR}`);
    assert.equal(result.partial, false);
    assert.equal(linked.has(1), false);
    assert.equal(linked.has(2), false);
    assert.equal(linked.has(101), true);
    assert.equal(linked.has(102), true);
    const signal = podSwapSignal(state.getPodSwap());
    assert.equal(signal.in_progress, false);
    assert.equal(signal.phase, "done");
    assert.ok(signal.started_at);
    assert.ok(signal.finished_at);
  });

  it("resumes after a 429 without repeating a confirmed add or detaching early", async () => {
    const ops: string[] = [];
    const linked = new Set<number>([...pads(FLOOR - 2).map((row) => row.id as number), 1, 2]);
    let low = linked.size;
    let failNext = true;
    const note = (): void => {
      if (linked.size < low) low = linked.size;
    };
    const accounts = () => [
      ...pads(FLOOR - 2),
      {
        id: 1,
        from_email: "off-a@client.info",
        client_id: 9,
        campaign_ids: [1],
        created_at: WARMED,
        is_smtp_success: true,
        is_imap_success: true,
        tags: [{ tag_name: "POD-A" }],
      },
      {
        id: 2,
        from_email: "off-b@client.info",
        client_id: 9,
        campaign_ids: [1],
        created_at: WARMED,
        is_smtp_success: true,
        is_imap_success: true,
        tags: [{ tag_name: "POD-A" }],
      },
      {
        id: 101,
        from_email: "on-a@client.info",
        client_id: 9,
        campaign_ids: [],
        created_at: WARMED,
        is_smtp_success: true,
        is_imap_success: true,
        tags: [{ tag_name: "POD-B" }],
      },
      {
        id: 102,
        from_email: "on-b@client.info",
        client_id: 9,
        campaign_ids: [],
        created_at: WARMED,
        is_smtp_success: true,
        is_imap_success: true,
        tags: [{ tag_name: "POD-B" }],
      },
    ];

    const state = new StateStore(
      `/tmp/client-rest-swap-resume-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Parlay", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => accounts(),
      addEmailAccountsToCampaign: async (_campaignId: number, ids: number[]) => {
        ops.push(`add:${ids[0]}`);
        if (failNext && ids[0] === 102) {
          throw new Error("HTTP 429");
        }
        linked.add(ids[0]!);
        note();
      },
      removeEmailAccountsFromCampaign: async (_campaignId: number, ids: number[]) => {
        ops.push(`remove:${ids[0]}`);
        linked.delete(ids[0]!);
        note();
      },
    } as unknown as SmartleadClient;
    const slack = { send: async () => undefined } as unknown as SlackClient;
    const config = loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" });

    const first = await new ClientRestService(config, smartlead, slack, state).run({
      dryRun: false,
      now: WEEK_46,
    });
    assert.equal(ops.some((op) => op.startsWith("remove:")), false);
    assert.equal(first.partial, true);
    assert.ok(first.errors.some((row) => row.includes("429")));
    const mid = podSwapSignal(state.getPodSwap());
    assert.equal(mid.in_progress, true);
    assert.equal(mid.finished_at, null);
    assert.ok(mid.started_at);
    assert.equal(linked.has(101), true);
    assert.ok(low >= FLOOR, `linked seats fell to ${low}`);

    failNext = false;
    const before = ops.length;
    const second = await new ClientRestService(config, smartlead, slack, state).run({
      dryRun: false,
      now: WEEK_46,
    });
    const rest = ops.slice(before);
    assert.equal(
      rest.filter((op) => op === "add:101").length,
      0,
      "confirmed add must not be repeated",
    );
    assert.ok(rest.includes("add:102"));
    const firstRemove = rest.findIndex((op) => op.startsWith("remove:"));
    const lastAdd = rest.findLastIndex((op) => op.startsWith("add:"));
    assert.ok(firstRemove > lastAdd, `resume must still add before remove: ${rest.join(" ")}`);
    assert.equal(second.partial, false);
    assert.equal(linked.has(1), false);
    assert.equal(linked.has(2), false);
    assert.equal(linked.has(101), true);
    assert.equal(linked.has(102), true);
    assert.ok(low >= FLOOR, `linked seats fell to ${low}`);
    const done = podSwapSignal(state.getPodSwap());
    assert.equal(done.in_progress, false);
    assert.equal(done.started_at, mid.started_at);
    assert.ok(done.finished_at);
  });
});
