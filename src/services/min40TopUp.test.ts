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
    assert.equal(result.asked.length, 0);
    assert.ok(
      slackCalls.every((line) => /is short \d+ staffable/.test(line)),
      "auto-allow must not open an Allow-generics card; under-40 ops_alert is ok",
    );
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

  it("never retags named seats or a generic across PODs", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./min40TopUp.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(src, /updateMailboxTags/);
    assert.match(src, /Never retag named seats/);
    assert.match(src, /Never retag a generic across PODs/);
    assert.match(src, /genericEligibleForClientPod|genericMayTakePod/);
  });

  it("D207: shares a client generic across that client's ACTIVE campaigns", async () => {
    const attached: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const named = Array.from({ length: 10 }, (_, i) => ({
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
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
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
          { id: 11, name: "BCP With Team", status: "ACTIVE", client_id: 542838 },
        ],
        accounts: [
          ...named,
          {
            id: 800,
            from_email: "shared@crosslaunchco.com",
            client_id: 542838,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [10],
          },
        ],
      },
    });
    assert.ok(
      attached.some((row) => row[0] === 11 && row[1].includes(800)),
      "already-assigned BCP generic must share onto the other BCP ACTIVE",
    );
    assert.equal(
      attached.some((row) => row[0] === 10 && row[1].includes(800)),
      false,
      "already-on campaign is not re-POSTed",
    );
    assert.ok(result.assigned.some((row) => row.email === "shared@crosslaunchco.com"));
  });

  it("D207/D237: never attaches a foreign-client seat; PowerGRYD asks Allow as a full client", async () => {
    const attached: Array<[number, number[]]> = [];
    const slackCalls: string[] = [];
    const state = new StateStore(stateFile());
    await state.load();
    const pgNamed = Array.from({ length: 8 }, (_, i) => ({
      id: 200 + i,
      from_email: `pg${i}@powergryd.com`,
      client_id: 592842,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      campaign_ids: [50],
    }));
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
          attached.push([id, ids]);
        },
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      {
        send: async (text: string) => {
          slackCalls.push(text);
        },
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => {
          slackCalls.push("Allow generics");
        },
      } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: new Date("2026-09-29T15:00:00Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [
          { id: 592842, name: "PowerGRYD", logo: "PowerGRYD" },
          { id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" },
        ],
        campaigns: [
          { id: 50, name: "PG Lane A", status: "ACTIVE", client_id: 592842 },
          { id: 51, name: "PG Lane B", status: "ACTIVE", client_id: 592842 },
        ],
        accounts: [
          ...pgNamed,
          {
            id: 801,
            from_email: "pg-shared@crosslaunchco.com",
            client_id: 592842,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [50],
          },
          {
            id: 802,
            from_email: "bcp-only@boldercyperpartner.com",
            client_id: 542838,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            campaign_ids: [],
          },
        ],
      },
    });
    assert.equal(
      attached.some((row) => row[1].includes(802)),
      false,
      "BCP named seat must not land on PowerGRYD",
    );
    assert.equal(
      attached.length,
      0,
      "PowerGRYD is not auto-allow — min40 does not fill without Allow (D237)",
    );
    assert.ok(result.asked.some((row) => row.campaignId === 50));
    assert.ok(result.asked.some((row) => row.campaignId === 51));
    assert.ok(slackCalls.some((line) => /Allow generics/.test(line)));
  });

  it("D207: does not staff a PAUSED campaign and alerts once per under-40 ACTIVE", async () => {
    const attached: Array<[number, number[]]> = [];
    const slackCalls: string[] = [];
    const state = new StateStore(stateFile());
    await state.load();
    const named = Array.from({ length: 8 }, (_, i) => ({
      id: 100 + i,
      from_email: `n${i}@boldercyperpartner.com`,
      client_id: 542838,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      campaign_ids: [10, 12],
    }));
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
          attached.push([id, ids]);
        },
        updateEmailAccount: async () => undefined,
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
    await service.run({
      dryRun: false,
      now: new Date("2026-09-29T15:00:00Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [
          { id: 10, name: "BCP Live", status: "ACTIVE", client_id: 542838 },
          { id: 12, name: "BCP Paused", status: "PAUSED", client_id: 542838 },
        ],
        accounts: named,
      },
    });
    assert.equal(
      attached.some((row) => row[0] === 12),
      false,
      "min40 must not attach onto PAUSED",
    );
    assert.ok(
      slackCalls.some(
        (line) =>
          /Bolder Cyber Partners/.test(line) && /is short \d+ staffable/.test(line),
      ),
      "under-40 ACTIVE client gets one short-staffed line (D248)",
    );
    assert.equal(
      slackCalls.some((line) => /BCP Paused/.test(line)),
      false,
      "paused campaign is not named in the short-staffed line",
    );
  });

  it("D209: does not unlink a CultureFits generic already shared across two ACTIVE camps at 40", async () => {
    const removed: Array<[number, number[]]> = [];
    const attached: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const shared = Array.from({ length: 40 }, (_, i) => ({
      id: 200 + i,
      from_email: `seat-${i}@useculturefits.info`,
      client_id: 542838,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "GENERIC" }],
      campaign_ids: [10, 11],
    }));
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
          attached.push([id, ids]);
        },
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async (
          campaignId: number,
          ids: number[],
        ) => {
          removed.push([campaignId, [...ids]]);
        },
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
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
          { id: 10, name: "BCP A", status: "ACTIVE", client_id: 542838 },
          { id: 11, name: "BCP B", status: "ACTIVE", client_id: 542838 },
        ],
        accounts: shared,
      },
    });
    assert.deepEqual(removed, [], "min40 must not peel same-client multi-link");
    assert.deepEqual(attached, []);
    assert.equal(result.assigned.length, 0);
    assert.equal(result.returned.length, 0);
  });

  it("D225: returns a surplus generic after the fill pass", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const named = Array.from({ length: 40 }, (_, i) => ({
      id: 100 + i,
      from_email: `n${i}@boldercyperpartner.com`,
      client_id: 542838,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "POD-A" }],
      campaign_ids: [10],
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async () => undefined,
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          writes.push({ id, fields });
        },
        removeEmailAccountsFromCampaign: async (
          campaignId: number,
          ids: number[],
        ) => {
          removed.push([campaignId, [...ids]]);
        },
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: new Date("2026-10-05T15:00:00.000Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [{ id: 10, name: "BCP A", status: "ACTIVE", client_id: 542838 }],
        accounts: [
          ...named,
          {
            id: 901,
            from_email: "extra@getintroduced.info",
            client_id: 542838,
            signature: "Ada Pool\nBolder Cyber Partners",
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
            campaign_ids: [10],
          },
        ],
      },
    });
    assert.equal(result.assigned.length, 0);
    assert.equal(result.returned.length, 1);
    assert.equal(result.returned[0]?.email, "extra@getintroduced.info");
    assert.deepEqual(removed, [[10, [901]]]);
    assert.deepEqual(writes, [{ id: 901, fields: { client_id: null, signature: "" } }]);
  });

  it("D228: does not attach an off-week POD-B generic onto an A-week campaign", async () => {
    const attached: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const named = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i,
      from_email: `n${i}@boldercyperpartner.com`,
      client_id: 542838,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "POD-A" }],
      campaign_ids: [10],
    }));
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
          attached.push([id, ids]);
        },
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: new Date("2026-10-05T15:00:00.000Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [{ id: 10, name: "BCP A", status: "ACTIVE", client_id: 542838 }],
        accounts: [
          ...named,
          {
            id: 800,
            from_email: "off-week@getintroduced.info",
            client_id: 542838,
            signature: "Ada Pool\nBolder Cyber Partners",
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }],
            campaign_ids: [],
          },
        ],
      },
    });
    assert.equal(
      attached.some((row) => row[1].includes(800)),
      false,
      "off-week POD-B generic stays assigned but must not link",
    );
    assert.equal(
      result.assigned.some((row) => row.email === "off-week@getintroduced.info"),
      false,
    );
  });

  it("D228: does not restaff off-week named onto an on-week campaign", async () => {
    const attached: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const onEmails = Array.from(
      { length: 37 },
      (_, i) => `on-${String(i).padStart(2, "0")}@client.info`,
    );
    const offEmails = ["off-a@client.info", "off-b@client.info", "off-c@client.info"];
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
          attached.push([id, ids]);
        },
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: new Date("2026-10-05T15:00:00.000Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [{ id: 10, name: "BCP A", status: "ACTIVE", client_id: 542838 }],
        accounts: [
          ...onEmails.map((from_email, i) => ({
            id: 100 + i,
            from_email,
            client_id: 542838,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "POD-A" }],
            campaign_ids: [10],
          })),
          ...offEmails.map((from_email, i) => ({
            id: 200 + i,
            from_email,
            client_id: 542838,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "POD-B" }],
            campaign_ids: [],
          })),
        ],
      },
    });
    assert.equal(
      attached.some((row) => row[1].some((id) => id >= 200 && id < 203)),
      false,
      "alphabetically-early POD-B named must not fill the on-week short",
    );
    assert.equal(
      result.assigned.some((row) => offEmails.includes(row.email)),
      false,
    );
  });

  it("D230: does not take another client's generic or move a POD-B seat to A", async () => {
    const attached: Array<[number, number[]]> = [];
    const tagWrites: Array<[number[], number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    state.upsertPoolMailbox({
      email: "foreign@getintroduced.info",
      domain: "getintroduced.info",
      platform: "GOOGLE",
      smartleadAccountId: 801,
      status: "assigned",
      assignedClientId: 999001,
      warmedAt,
    });
    state.upsertPoolMailbox({
      email: "other-pod@getintroduced.info",
      domain: "getintroduced.info",
      platform: "GOOGLE",
      smartleadAccountId: 802,
      status: "assigned",
      assignedClientId: 542838,
      warmedAt,
    });
    const named = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i,
      from_email: `n${i}@boldercyperpartner.com`,
      client_id: 542838,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "POD-A" }],
      campaign_ids: [10],
    }));
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
          attached.push([id, ids]);
        },
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        ensureTag: async (name: string) => ({
          id: name === "POD-A" ? 71 : 72,
          name,
        }),
        assignTags: async (accountIds: number[], tagIds: number[]) => {
          tagWrites.push([accountIds, tagIds]);
        },
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: new Date("2026-10-05T15:00:00.000Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [{ id: 10, name: "BCP A", status: "ACTIVE", client_id: 542838 }],
        accounts: [
          ...named,
          {
            id: 801,
            from_email: "foreign@getintroduced.info",
            client_id: 999001,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
            campaign_ids: [],
          },
          {
            id: 802,
            from_email: "other-pod@getintroduced.info",
            client_id: 542838,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }],
            campaign_ids: [],
          },
        ],
      },
    });
    assert.equal(
      attached.some((row) => row[1].includes(801) || row[1].includes(802)),
      false,
      "must not take a foreign generic or flip a POD-B seat onto A",
    );
    assert.equal(
      result.assigned.some((row) =>
        ["foreign@getintroduced.info", "other-pod@getintroduced.info"].includes(
          row.email,
        ),
      ),
      false,
    );
    assert.equal(
      tagWrites.some((row) => row[0].includes(802)),
      false,
      "must not retag the POD-B generic",
    );
  });

  it("D230: stamps the first POD tag on an untagged pool assign", async () => {
    const tagWrites: Array<[number[], number[]]> = [];
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
      tags: [{ tag_name: "POD-A" }],
      campaign_ids: [10],
    }));
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async () => undefined,
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        ensureTag: async (name: string) => ({
          id: name === "POD-A" ? 71 : 72,
          name,
        }),
        assignTags: async (accountIds: number[], tagIds: number[]) => {
          tagWrites.push([accountIds, tagIds]);
        },
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    await service.run({
      dryRun: false,
      now: new Date("2026-10-05T15:00:00.000Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [{ id: 10, name: "BCP A", status: "ACTIVE", client_id: 542838 }],
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
    assert.deepEqual(tagWrites, [[[900], [71]]]);
    assert.equal(state.getGenericSeat("spare@crosslaunchco.com")?.assignedPod, "A");
  });

  it("D236: fills a Deep Roots DRAFTED POC to 60 with no Allow ask and no Gabe staff", async () => {
    const attached: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const tagWrites: Array<[number[], number[]]> = [];
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
        ensureTag: async (name: string) => ({
          id: name === "POC" ? 531428 : 99,
          name,
        }),
        assignTags: async (accountIds: number[], tagIds: number[]) => {
          tagWrites.push([accountIds, tagIds]);
        },
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
      now: new Date("2026-10-05T15:00:00.000Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 597783, name: "Deep Roots", logo: "Deep Roots Capital" }],
        campaigns: [
          { id: 4084613, name: "Deep Roots A", status: "DRAFTED", client_id: 597783 },
          { id: 4084614, name: "Deep Roots B", status: "DRAFTED", client_id: 597783 },
          {
            id: 4074266,
            name: "Post-call | Gabe | Deep Roots",
            status: "DRAFTED",
            client_id: 597783,
          },
          {
            id: 4085160,
            name: "Gabe Calls | Deep Roots",
            status: "DRAFTED",
            client_id: 597783,
          },
        ],
        accounts: [
          {
            id: 1,
            from_email: "one@crosslaunchco.com",
            from_name: "Ada Lovelace",
            client_id: 597783,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POC" }],
            campaign_ids: [4084613],
          },
          {
            id: 2,
            from_email: "two@crosslaunchco.com",
            from_name: "Ben Franklin",
            client_id: 597783,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POC" }],
            campaign_ids: [4084613],
          },
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
    assert.equal(result.asked.length, 0);
    assert.equal(
      slackCalls.some((line) => /Allow generics/i.test(line)),
      false,
    );
    assert.ok(result.unfilled.length >= 1);
    assert.ok(attached.some((row) => row[0] === 4084613 && row[1].includes(900)));
    assert.ok(attached.some((row) => row[0] === 4084614 && row[1].includes(900)));
    assert.equal(
      attached.some((row) => row[0] === 4074266),
      false,
    );
    assert.equal(
      attached.some((row) => row[0] === 4085160),
      false,
    );
    assert.ok(
      updates.some(
        (row) =>
          row.id === 900 &&
          row.fields.signature === "Harmony Norris\nDeep Roots Capital" &&
          row.fields.client_id === 597783,
      ),
    );
    assert.deepEqual(tagWrites, [[[900], [531428]]]);
    assert.equal(
      state.getGenericSeat("spare@crosslaunchco.com")?.reason,
      "poc_engagement",
    );
    assert.equal(state.getGenericSeat("spare@crosslaunchco.com")?.assignedPod, null);
  });

  it("D241: does not fill a campaign whose linked seats are GABE-VM-RESERVED", async () => {
    const attached: Array<[number, number[]]> = [];
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
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
          attached.push([id, ids]);
        },
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        ensureTag: async (name: string) => ({
          id: name === "POC" ? 531428 : 99,
          name,
        }),
        assignTags: async () => undefined,
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    await service.run({
      dryRun: false,
      now: new Date("2026-10-06T15:00:00.000Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 597783, name: "Deep Roots", logo: "Deep Roots Capital" }],
        campaigns: [
          {
            id: 4090001,
            name: "Deep Roots Voicemail",
            status: "DRAFTED",
            client_id: 597783,
          },
        ],
        accounts: [
          {
            id: 24255314,
            from_email: "gabriel@salesglider.com",
            from_name: "Gabe Lopez",
            client_id: 345263,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GABE-VM-RESERVED" }],
            campaign_ids: [4090001],
          },
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
    assert.equal(
      attached.some((row) => row[0] === 4090001),
      false,
    );
  });

  it("D242: does not fill Gabe Calls | SalesGlider or Deep Roots 4085160", async () => {
    const attached: Array<[number, number[]]> = [];
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
    const service = new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      {
        addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
          attached.push([id, ids]);
        },
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        ensureTag: async (name: string) => ({ id: 1, name }),
        assignTags: async () => undefined,
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    await service.run({
      dryRun: false,
      now: new Date("2026-10-06T15:00:00.000Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [
          { id: 345263, name: "SalesGlider", logo: "SalesGlider" },
          { id: 597783, name: "Deep Roots", logo: "Deep Roots Capital" },
        ],
        campaigns: [
          {
            id: 4085158,
            name: "Gabe Calls | SalesGlider",
            status: "ACTIVE",
            client_id: 345263,
          },
          {
            id: 4085160,
            name: "Gabe Calls | Deep Roots",
            status: "DRAFTED",
            client_id: 597783,
          },
        ],
        accounts: [
          {
            id: 24255344,
            from_email: "gabriel@sorrelquotaio.co",
            from_name: "Gabriel Lopez",
            client_id: 345263,
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GABE-VM-RESERVED" }],
            campaign_ids: [4085158, 4085160],
          },
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
    assert.equal(attached.some((row) => row[0] === 4085158), false);
    assert.equal(attached.some((row) => row[0] === 4085160), false);
  });

  it("D238: never attaches a living Canary-signature fleet seat to TechEvo", async () => {
    const attached: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const state = new StateStore(stateFile());
    await state.load();
    state.ensureGenericSeat({
      email: "ada@newcanary.test",
      slAccountId: 22637921,
    });
    const named = Array.from({ length: 8 }, (_, i) => ({
      id: 100 + i,
      from_email: `n${i}@techevolution.com`,
      client_id: 521881,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "POD-A" }],
      campaign_ids: [3847798],
      created_at: "2026-01-01T00:00:00.000Z",
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
        ensureTag: async (name: string) => ({ id: 1, name }),
        assignTags: async () => undefined,
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
        notifyIsolationAction: async () => undefined,
        notifyGenericBackfillBatch: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    await service.run({
      dryRun: false,
      now: new Date("2026-10-05T15:00:00.000Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 521881, name: "TechEvo", logo: "TechEvolution" }],
        campaigns: [
          { id: 3847798, name: "TechEvo A", status: "ACTIVE", client_id: 521881 },
        ],
        accounts: [
          ...named,
          {
            id: 22637921,
            from_email: "ada@newcanary.test",
            from_name: "Ada Lovelace",
            signature: "Ada Lovelace\nCanary",
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "CANARY" }],
            campaign_ids: [],
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    assert.equal(
      attached.some((row) => row[1].includes(22637921)),
      false,
    );
    assert.equal(
      updates.some((row) => row.id === 22637921),
      false,
    );
  });
});
