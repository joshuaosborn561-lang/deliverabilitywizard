import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { emptyGenericSeat } from "../lib/genericPool.js";
import { StateStore } from "../state/store.js";
import { GenericCleanupService } from "./genericCleanup.js";

const WEEKDAY = new Date("2026-10-05T15:00:00.000Z");
const WEEKEND = new Date("2026-10-03T15:00:00.000Z");

function stateFile(): string {
  return `/tmp/genclean-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function namedPodA(clientId: number, campaignId: number, n = 40) {
  return Array.from({ length: n }, (_, i) => ({
    id: 100 + i,
    from_email: `n${i}@techevolution.com`,
    client_id: clientId,
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    tags: [{ tag_name: "POD-A" }],
    campaign_ids: [campaignId],
  }));
}

describe("GenericCleanupService (D205)", () => {
  it("clears client_id + signature when a GENERIC is off that client's ACTIVE campaigns", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const service = new GenericCleanupService(
      loadConfig({ DRY_RUN: "false" }),
      {
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
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: WEEKDAY,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 521881, name: "TechEvo", logo: "TechEvolution" }],
        campaigns: [
          { id: 1, name: "TechEvo A", status: "PAUSED", client_id: 521881 },
          { id: 2, name: "TechEvo B", status: "ACTIVE", client_id: 521881 },
        ],
        accounts: [
          {
            id: 10,
            from_email: "gone@pool.info",
            client_id: 521881,
            signature: "Ada Lovelace\nTechEvolution",
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [1],
          },
          {
            id: 11,
            from_email: "live@pool.info",
            client_id: 521881,
            signature: "Ada Lovelace\nTechEvolution",
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [2],
          },
          {
            id: 12,
            from_email: "named@techevolution.com",
            client_id: 521881,
            signature: "Named Seat\nTechEvolution",
            campaign_ids: [1],
          },
          {
            id: 13,
            from_email: "pg@pool.info",
            client_id: 592842,
            signature: "Pat\nPowerGRYD",
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [],
          },
        ],
      },
    });
    assert.deepEqual(writes, [{ id: 10, fields: { client_id: null, signature: "" } }]);
    assert.deepEqual(removed, [[1, [10]]]);
    assert.equal(result.cleared.length, 1);
    assert.equal(result.cleared[0]?.email, "gone@pool.info");
    assert.equal(result.returned.length, 0);
  });

  it("D209: CultureFits generic still on two ACTIVE camps of that client is not cleared", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const service = new GenericCleanupService(
      loadConfig({ DRY_RUN: "false" }),
      {
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          writes.push({ id, fields });
        },
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: WEEKDAY,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [
          { id: 3763799, name: "BCP HC With Team", status: "ACTIVE", client_id: 542838 },
          { id: 3763800, name: "BCP HC No Team", status: "ACTIVE", client_id: 542838 },
        ],
        accounts: [
          {
            id: 11,
            from_email: "ada@useculturefits.info",
            client_id: 542838,
            signature: "Ada Pool\nBolder Cyber Partners",
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [3763799, 3763800],
          },
        ],
      },
    });
    assert.deepEqual(writes, []);
    assert.equal(result.cleared.length, 0);
    assert.equal(result.returned.length, 0);
  });

  it("D225: unlinks a surplus generic and returns it to the pool", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    state.upsertGenericSeat(
      emptyGenericSeat("extra@getintroduced.info", {
        slAccountId: 901,
        assignedClientId: 521881,
        assignedCampaignIds: [2],
        assignedPod: "A",
        assignedAt: "2026-10-02T00:00:00.000Z",
        reason: "pod_top_up",
      }),
    );
    state.upsertPoolMailbox({
      email: "extra@getintroduced.info",
      domain: "getintroduced.info",
      platform: "GOOGLE",
      smartleadAccountId: 901,
      firstName: "Ada",
      lastName: "Pool",
      status: "assigned",
      assignedClientId: 521881,
      assignedClientName: "TechEvo",
      assignedAt: "2026-10-02T00:00:00.000Z",
    });
    const service = new GenericCleanupService(
      loadConfig({ DRY_RUN: "false" }),
      {
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
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: WEEKDAY,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 521881, name: "TechEvo", logo: "TechEvolution" }],
        campaigns: [{ id: 2, name: "TechEvo B", status: "ACTIVE", client_id: 521881 }],
        accounts: [
          ...namedPodA(521881, 2),
          {
            id: 901,
            from_email: "extra@getintroduced.info",
            client_id: 521881,
            signature: "Ada Pool\nTechEvolution",
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
            campaign_ids: [2],
          },
        ],
      },
    });
    assert.deepEqual(removed, [[2, [901]]]);
    assert.deepEqual(writes, [{ id: 901, fields: { client_id: null, signature: "" } }]);
    assert.equal(result.cleared.length, 0);
    assert.equal(result.returned.length, 1);
    assert.equal(result.returned[0]?.email, "extra@getintroduced.info");
    assert.equal(state.getGenericSeat("extra@getintroduced.info")?.assignedClientId, null);
    assert.equal(state.getPoolMailbox("extra@getintroduced.info")?.status, "available");
  });

  it("D225: does not return surplus on a Chicago weekend", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const service = new GenericCleanupService(
      loadConfig({ DRY_RUN: "false" }),
      {
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          writes.push({ id, fields });
        },
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: WEEKEND,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 521881, name: "TechEvo", logo: "TechEvolution" }],
        campaigns: [{ id: 2, name: "TechEvo B", status: "ACTIVE", client_id: 521881 }],
        accounts: [
          ...namedPodA(521881, 2),
          {
            id: 901,
            from_email: "extra@getintroduced.info",
            client_id: 521881,
            signature: "Ada Pool\nTechEvolution",
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
            campaign_ids: [2],
          },
        ],
      },
    });
    assert.deepEqual(writes, []);
    assert.equal(result.returned.length, 0);
  });

  it("D228: keeps a needed off-week POD-B assignment with no campaign links", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const service = new GenericCleanupService(
      loadConfig({ DRY_RUN: "false" }),
      {
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
      state,
    );
    const result = await service.run({
      dryRun: false,
      now: WEEKDAY,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 521881, name: "TechEvo", logo: "TechEvolution" }],
        campaigns: [{ id: 2, name: "TechEvo B", status: "ACTIVE", client_id: 521881 }],
        accounts: [
          ...namedPodA(521881, 2),
          {
            id: 902,
            from_email: "keep-b@getintroduced.info",
            client_id: 521881,
            signature: "Ada Pool\nTechEvolution",
            type: "GMAIL",
            is_smtp_success: true,
            is_imap_success: true,
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }],
            campaign_ids: [],
          },
        ],
      },
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(removed, []);
    assert.equal(result.cleared.length, 0);
    assert.equal(result.returned.length, 0);
  });
});
