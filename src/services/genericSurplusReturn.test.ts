import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { emptyGenericSeat } from "../lib/genericPool.js";
import { StateStore } from "../state/store.js";
import { returnSurplusGenerics } from "./genericSurplusReturn.js";

const WEEKDAY = new Date("2026-10-05T15:00:00.000Z");
const WEEKEND = new Date("2026-10-03T15:00:00.000Z");

function stateFile(): string {
  return `/tmp/gensurplus-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function namedPodA(
  clientId: number,
  campaignIds: number[],
  n = 40,
  idBase = 100,
  domain = "techevolution.com",
) {
  return Array.from({ length: n }, (_, i) => ({
    id: idBase + i,
    from_email: `n${i}@${domain}`,
    client_id: clientId,
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    tags: [{ tag_name: "POD-A" }],
    campaign_ids: campaignIds,
    created_at: "2026-01-01T00:00:00.000Z",
  }));
}

function extraGeneric(input: {
  id: number;
  email: string;
  clientId: number;
  campaignIds: number[];
}) {
  return {
    id: input.id,
    from_email: input.email,
    client_id: input.clientId,
    signature: "Ada Pool\nTechEvolution",
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
    campaign_ids: input.campaignIds,
  };
}

async function readyState(): Promise<StateStore> {
  const state = new StateStore(stateFile());
  await state.load();
  return state;
}

function tagOps() {
  const removedTags: Array<[number[], number[]]> = [];
  return {
    removedTags,
    ensureTag: async (name: string) => ({
      id: name === "POD-A" ? 1 : name === "POD-B" ? 2 : 3,
      name,
    }),
    removeTags: async (ids: number[], tagIds: number[]) => {
      removedTags.push([ids, tagIds]);
    },
  };
}

describe("returnSurplusGenerics (D225/D235)", () => {
  it("unlinks a surplus generic, clears client_id/signature/POD, and records released_at", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const removed: Array<[number, number[]]> = [];
    const tags = tagOps();
    const state = await readyState();
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
      status: "assigned",
      assignedClientId: 521881,
      assignedClientName: "TechEvo",
      assignedAt: "2026-10-02T00:00:00.000Z",
    });
    const result = await returnSurplusGenerics({
      config: loadConfig({ DRY_RUN: "false" }),
      smartlead: {
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          writes.push({ id, fields });
        },
        removeEmailAccountsFromCampaign: async (
          campaignId: number,
          ids: number[],
        ) => {
          removed.push([campaignId, [...ids]]);
        },
        ensureTag: tags.ensureTag,
        removeTags: tags.removeTags,
      } as unknown as SmartleadClient,
      state,
      now: WEEKDAY,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 521881, name: "TechEvo", logo: "TechEvolution" }],
        campaigns: [{ id: 2, name: "TechEvo B", status: "ACTIVE", client_id: 521881 }],
        accounts: [
          ...namedPodA(521881, [2]),
          extraGeneric({
            id: 901,
            email: "extra@getintroduced.info",
            clientId: 521881,
            campaignIds: [2],
          }),
        ],
      },
    });
    assert.deepEqual(removed, [[2, [901]]]);
    assert.deepEqual(writes, [{ id: 901, fields: { client_id: null, signature: "" } }]);
    assert.deepEqual(tags.removedTags, [[[901], [1, 2, 3]]]);
    assert.equal(result.returned.length, 1);
    assert.equal(result.returned[0]?.email, "extra@getintroduced.info");
    assert.equal(result.returned[0]?.clientId, 521881);
    const seat = state.getGenericSeat("extra@getintroduced.info");
    assert.equal(seat?.assignedClientId, null);
    assert.equal(seat?.assignedPod, null);
    assert.equal(seat?.releasedAt, WEEKDAY.toISOString());
    assert.equal(seat?.releaseHistory.length, 1);
    assert.equal(seat?.releaseHistory[0]?.clientId, 521881);
    assert.equal(seat?.releaseHistory[0]?.pod, "A");
    assert.equal(seat?.releaseHistory[0]?.reason, "named_warm_swap");
    assert.equal(state.getPoolMailbox("extra@getintroduced.info")?.assignedClientId, undefined);
    assert.equal(state.getPoolMailbox("extra@getintroduced.info")?.status, "available");
  });

  it("skips an active 24h TERRL substitute; PowerGRYD surplus returns (D237)", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const removed: Array<[number, number[]]> = [];
    const tags = tagOps();
    const state = await readyState();
    state.upsertTerlSubstitution({
      stoppedAccountId: 1,
      stoppedEmail: "stopped@techevolution.com",
      substituteAccountId: 902,
      substituteEmail: "swap@getintroduced.info",
      campaignId: 2,
      campaignName: "TechEvo B",
      clientId: 521881,
      clientName: "TechEvo",
      tenant: "techevolution.com",
      stoppedAt: "2026-10-05T12:00:00.000Z",
      restoreAfter: "2026-10-06T15:00:00.000Z",
      restoredAt: null,
      noSubstitute: false,
    });
    const result = await returnSurplusGenerics({
      config: loadConfig({ DRY_RUN: "false" }),
      smartlead: {
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          writes.push({ id, fields });
        },
        removeEmailAccountsFromCampaign: async (
          campaignId: number,
          ids: number[],
        ) => {
          removed.push([campaignId, [...ids]]);
        },
        ensureTag: tags.ensureTag,
        removeTags: tags.removeTags,
      } as unknown as SmartleadClient,
      state,
      now: WEEKDAY,
      inventory: {
        fetchedAt: Date.now(),
        clients: [
          { id: 521881, name: "TechEvo", logo: "TechEvolution" },
          { id: 592842, name: "PowerGRYD", logo: "PowerGRYD" },
        ],
        campaigns: [
          { id: 2, name: "TechEvo B", status: "ACTIVE", client_id: 521881 },
          { id: 50, name: "PG Lane", status: "ACTIVE", client_id: 592842 },
        ],
        accounts: [
          ...namedPodA(521881, [2]),
          ...namedPodA(592842, [50], 40, 300, "powergryd.com"),
          extraGeneric({
            id: 902,
            email: "swap@getintroduced.info",
            clientId: 521881,
            campaignIds: [2],
          }),
          extraGeneric({
            id: 903,
            email: "pg@getintroduced.info",
            clientId: 592842,
            campaignIds: [50],
          }),
          extraGeneric({
            id: 904,
            email: "keep-me@getintroduced.info",
            clientId: 521881,
            campaignIds: [2],
          }),
        ],
      },
    });
    assert.deepEqual(
      result.returned.map((row) => row.email).sort(),
      ["keep-me@getintroduced.info", "pg@getintroduced.info"],
    );
    assert.equal(
      removed.some((row) => row[1].includes(902)),
      false,
      "TERRL substitute stays",
    );
    assert.ok(removed.some((row) => row[1].includes(903)));
    assert.ok(removed.some((row) => row[1].includes(904)));
    assert.ok(
      writes.some((row) => row.id === 903 && row.fields.client_id === null),
    );
    assert.ok(
      writes.some((row) => row.id === 904 && row.fields.client_id === null),
    );
    assert.ok(tags.removedTags.some((row) => row[0][0] === 903));
    assert.ok(tags.removedTags.some((row) => row[0][0] === 904));
    assert.equal(state.getGenericSeat("keep-me@getintroduced.info")?.releasedAt, WEEKDAY.toISOString());
    assert.equal(state.getGenericSeat("pg@getintroduced.info")?.releasedAt, WEEKDAY.toISOString());
  });

  it("does nothing on a Chicago weekend", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const state = await readyState();
    const result = await returnSurplusGenerics({
      config: loadConfig({ DRY_RUN: "false" }),
      smartlead: {
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          writes.push({ id, fields });
        },
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      state,
      now: WEEKEND,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 521881, name: "TechEvo", logo: "TechEvolution" }],
        campaigns: [{ id: 2, name: "TechEvo B", status: "ACTIVE", client_id: 521881 }],
        accounts: [
          ...namedPodA(521881, [2]),
          extraGeneric({
            id: 901,
            email: "extra@getintroduced.info",
            clientId: 521881,
            campaignIds: [2],
          }),
        ],
      },
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(result.returned, []);
  });

  it("never unlinks a generic when that would drop the ACTIVE campaign below 40 staffable", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const removed: Array<[number, number[]]> = [];
    const state = await readyState();
    const result = await returnSurplusGenerics({
      config: loadConfig({ DRY_RUN: "false" }),
      smartlead: {
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
      now: WEEKDAY,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 521881, name: "TechEvo", logo: "TechEvolution" }],
        campaigns: [{ id: 2, name: "TechEvo B", status: "ACTIVE", client_id: 521881 }],
        accounts: [
          ...namedPodA(521881, [2], 40).map((row, i) =>
            i < 38 ? row : { ...row, campaign_ids: [] },
          ),
          extraGeneric({
            id: 901,
            email: "needed@getintroduced.info",
            clientId: 521881,
            campaignIds: [2],
          }),
          extraGeneric({
            id: 902,
            email: "also-needed@getintroduced.info",
            clientId: 521881,
            campaignIds: [2],
          }),
        ],
      },
    });
    assert.deepEqual(removed, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(result.returned, []);
  });
});
