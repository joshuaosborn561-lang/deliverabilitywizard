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
      slackCalls.every((line) => /staffable \(short/.test(line)),
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

  it("never writes POD tags", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./min40TopUp.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(src, /updateMailboxTags/);
    assert.match(src, /Never retag named seats/);
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

  it("D207: never attaches a foreign-client seat and restaffs PowerGRYD", async () => {
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
        notifyGenericBackfillBatch: async () => undefined,
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
    assert.ok(
      attached.some((row) => row[0] === 51 && row[1].includes(801)),
      "PG generic shares onto the other PG ACTIVE",
    );
    assert.equal(
      attached.some((row) => row[1].includes(802)),
      false,
      "BCP named seat must not land on PowerGRYD",
    );
    assert.ok(result.unfilled.length >= 1);
    assert.ok(slackCalls.some((line) => /PowerGRYD has \d+ staffable seats/.test(line)));
    assert.ok(slackCalls.some((line) => /PG Lane A/.test(line) || /50/.test(line)));
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
    assert.ok(slackCalls.some((line) => /BCP Live/.test(line) && /40/.test(line)));
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
  });

  it("D209: restaffs a short ACTIVE campaign from same-client generics that still carry a rest record", async () => {
    const attached: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const attachedAlready = Array.from({ length: 31 }, (_, i) => ({
      id: 100 + i,
      from_email: `on-${i}@useculturefits.info`,
      client_id: 542838,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      created_at: "2026-01-01T00:00:00Z",
      tags: [{ tag_name: "GENERIC" }],
      campaign_ids: [10],
    }));
    const benched = Array.from({ length: 9 }, (_, i) => {
      const email = `ada-${i}@useculturefits.info`;
      state.markRestingInbox({
        accountId: 400 + i,
        email,
        clientId: "id:542838",
        cohort: "B",
        kind: "client",
        restingSince: "2026-09-29T00:50:00Z",
        removedFromCampaigns: [10],
        lastSameEspInbox: null,
      });
      return {
        id: 400 + i,
        from_email: email,
        client_id: 542838,
        type: "GMAIL",
        is_smtp_success: true,
        is_imap_success: true,
        created_at: "2026-01-01T00:00:00Z",
        tags: [{ tag_name: "GENERIC" }],
        campaign_ids: [] as number[],
      };
    });
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
      now: new Date("2026-09-30T15:00:00Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [
          { id: 10, name: "BCP Live", status: "ACTIVE", client_id: 542838 },
        ],
        accounts: [...attachedAlready, ...benched],
      },
    });
    const benchedIds = benched.map((row) => row.id);
    assert.equal(result.assigned.length, 9);
    assert.equal(
      attached.filter((row) => row[0] === 10 && row[1].some((id) => benchedIds.includes(id)))
        .length,
      9,
      "min40 must put the incorrectly-benched same-client generics back",
    );
    for (const row of benched) {
      assert.equal(
        state.getRestingInbox(row.from_email),
        undefined,
        `${row.from_email} rest record must clear on attach`,
      );
    }
  });

  it("D209: pool short-fill can take a resting free-pool generic and clear the record", async () => {
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
    state.markRestingInbox({
      accountId: 900,
      email: "spare@crosslaunchco.com",
      clientId: "unknown",
      cohort: "A",
      kind: "generic",
      restingSince: "2026-09-29T03:00:00Z",
      removedFromCampaigns: [10],
      lastSameEspInbox: null,
    });
    const named = Array.from({ length: 39 }, (_, i) => ({
      id: 100 + i,
      from_email: `n${i}@boldercyperpartner.com`,
      client_id: 542838,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      created_at: "2026-01-01T00:00:00Z",
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
      now: new Date("2026-09-30T15:00:00Z"),
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [
          { id: 10, name: "BCP Live", status: "ACTIVE", client_id: 542838 },
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
    assert.ok(
      attached.some((row) => row[0] === 10 && row[1].includes(900)),
      "min40 must reuse a resting free-pool generic to hit 40",
    );
    assert.equal(result.assigned.length, 1);
    assert.equal(state.getRestingInbox("spare@crosslaunchco.com"), undefined);
  });
});
