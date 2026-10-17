import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isInsightTaggedGeneric,
  isPowerGrydNoGenericsFinding,
  planGenericLedgerCleanupCounts,
  runGenericLedgerCleanup,
} from "./genericLedgerCleanup.js";
import { emptyGenericSeat } from "./genericPool.js";
import { StateStore } from "../state/store.js";
import { INSIGHT_CLIENT_ID } from "./insightCampaigns.js";

function stateFile(): string {
  return `/tmp/ledger-cleanup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

const config = {
  extraGenericMailboxes: [],
  extraGenericDomains: ["getintroduced.info", "meetconnectbox.com"],
  prewarmedDomains: [],
  dryRun: false,
};

describe("D286 one-time generics ledger cleanup", () => {
  it("plans Insight / CornerStone / stale-POD / PowerGRYD-finding counts", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    state.setGenericPoolFindings([
      "generic_idle: PowerGRYD no generics on POD-A",
      "generic_idle: other",
    ]);
    const plan = planGenericLedgerCleanupCounts({
      accounts: [
        {
          id: 1,
          email: "insight@getintroduced.info",
          client_id: INSIGHT_CLIENT_ID,
          tags: [{ tag_name: "GENERIC" }],
        },
        {
          id: 2,
          email: "owen@cornerstoneearthworksmy.info",
          client_id: 574088,
          tags: [{ tag_name: "GENERIC" }],
        },
        {
          id: 3,
          email: "stale@getintroduced.info",
          client_id: null,
          tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
        },
        {
          id: 4,
          email: "ok@getintroduced.info",
          client_id: 77,
          tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
        },
      ],
      state,
      config,
    });
    assert.equal(plan.insightTagged, 1);
    assert.equal(plan.cornerstoneDomain, 1);
    assert.equal(plan.unassignedWithPodTags, 1);
    assert.equal(plan.powergrydNoGenericsFindings, 1);
    assert.equal(isInsightTaggedGeneric({ account: { client_id: INSIGHT_CLIENT_ID } }), true);
    assert.equal(isPowerGrydNoGenericsFinding("PowerGRYD no generics"), true);
  });

  it("is idempotent and skips STOPPED campaigns", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    state.upsertGenericSeat(
      emptyGenericSeat("insight@getintroduced.info", {
        slAccountId: 1,
        assignedClientId: INSIGHT_CLIENT_ID,
      }),
    );
    const removed: number[] = [];
    const updated: number[] = [];
    const smartlead = {
      updateEmailAccount: async (id: number) => {
        updated.push(id);
      },
      removeEmailAccountsFromCampaign: async (campaignId: number) => {
        removed.push(campaignId);
      },
      ensureTag: async (name: string) => ({ id: name === "POD-A" ? 1 : 2 }),
      removeTags: async () => {},
    };
    const accounts = [
      {
        id: 1,
        email: "insight@getintroduced.info",
        client_id: INSIGHT_CLIENT_ID,
        campaign_ids: [99, 100],
        tags: [{ tag_name: "GENERIC" }],
      },
    ];
    const campaigns = [
      { id: 99, status: "STOPPED", client_id: INSIGHT_CLIENT_ID },
      { id: 100, status: "PAUSED", client_id: INSIGHT_CLIENT_ID },
    ];
    const first = await runGenericLedgerCleanup({
      config,
      smartlead,
      state,
      accounts,
      campaigns,
      now: new Date("2026-10-17T20:00:00.000Z"),
    });
    assert.equal(first.skipped, false);
    assert.equal(first.insightReleased, 1);
    assert.ok(!removed.includes(99), "must not touch STOPPED");
    assert.ok(removed.includes(100));
    const second = await runGenericLedgerCleanup({
      config,
      smartlead,
      state,
      accounts,
      campaigns,
    });
    assert.equal(second.skipped, true);
    assert.equal(second.insightReleased, 1);
  });
});
