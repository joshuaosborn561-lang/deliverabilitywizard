import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { HeldInboxRecord, StateStore } from "../state/store.js";
import { RemediationService } from "./remediation.js";

/**
 * A mailbox marked held but still attached to an ACTIVE campaign is still
 * sending. The main recovery loop skips anything already held, so nothing
 * retries it — this reconcile pass does.
 */

const config = loadConfig({});

function heldRecord(email: string): HeldInboxRecord {
  return {
    accountId: 1,
    email,
    heldAt: "2026-08-05T00:00:00.000Z",
    holdUntil: "2026-08-19",
    tagName: "HOLD-UNTIL-2026-08-19",
  };
}

function fixture(opts: {
  heldEmails?: string[];
  campaignMembers?: Record<number, Array<{ id: number }>>;
  failRemoval?: boolean;
}) {
  const removed: Array<[number, number[]]> = [];
  const paused: number[] = [];
  const heldSet = new Set((opts.heldEmails ?? []).map((e) => e.toLowerCase()));

  const state = {
    getHeldInbox: (email: string) =>
      heldSet.has(email.toLowerCase()) ? heldRecord(email) : undefined,
    getRestingInbox: () => undefined,
    listRestingInboxes: () => [],
    markPendingResume: (r: { campaignId: number }) => {
      paused.push(r.campaignId);
    },
  } as unknown as StateStore;

  const smartlead = {
    getCampaignEmailAccounts: async (id: number) =>
      opts.campaignMembers?.[id] ?? [{ id: 1 }, { id: 2 }],
    removeEmailAccountsFromCampaign: async (id: number, ids: number[]) => {
      if (opts.failRemoval) throw new Error("Smartlead 500");
      removed.push([id, [...ids]]);
    },
    updateCampaignStatus: async () => undefined,
  } as unknown as SmartleadClient;

  const service = new RemediationService(
    config,
    smartlead,
    {} as unknown as SmartDeliveryClient,
    null,
    { send: async () => undefined } as unknown as SlackClient,
    state,
    undefined as never,
  );

  return { service, removed, paused };
}

const account = (email: string, campaignIds: number[]) => ({
  id: 1,
  from_email: email,
  campaign_ids: campaignIds,
  tags: [],
});

describe("held mailboxes still on ACTIVE campaigns", () => {
  it("re-pulls a held mailbox that is still attached", async () => {
    const { service, removed } = fixture({ heldEmails: ["stuck@x.com"] });

    const out = await service.reconcileHeldStillOnCampaigns({
      accounts: [account("stuck@x.com", [10, 11])] as never,
      campaignStatus: new Map([
        [10, "ACTIVE"],
        [11, "ACTIVE"],
      ]),
      dryRun: false,
    });

    assert.equal(out.stillActive, 1);
    assert.equal(out.repulled.length, 1);
    assert.deepEqual(out.repulled[0]?.campaignIds, [10, 11]);
    assert.deepEqual(removed, [
      [10, [1]],
      [11, [1]],
    ]);
  });

  it("leaves a held mailbox alone when it is already off active campaigns", async () => {
    const { service, removed } = fixture({ heldEmails: ["clean@x.com"] });

    const out = await service.reconcileHeldStillOnCampaigns({
      accounts: [account("clean@x.com", [10])] as never,
      campaignStatus: new Map([[10, "PAUSED"]]),
      dryRun: false,
    });

    assert.equal(out.heldChecked, 1);
    assert.equal(out.stillActive, 0);
    assert.deepEqual(removed, []);
  });

  it("ignores mailboxes that are not held", async () => {
    const { service, removed } = fixture({ heldEmails: [] });

    const out = await service.reconcileHeldStillOnCampaigns({
      accounts: [account("healthy@x.com", [10])] as never,
      campaignStatus: new Map([[10, "ACTIVE"]]),
      dryRun: false,
    });

    assert.equal(out.heldChecked, 0);
    assert.equal(out.stillActive, 0);
    assert.deepEqual(removed, []);
  });

  it("catches a mailbox held only by an unexpired HOLD-UNTIL tag", async () => {
    const { service, removed } = fixture({ heldEmails: [] });
    const tagged = {
      id: 1,
      from_email: "tagged@x.com",
      campaign_ids: [10],
      tags: [{ tag_name: "HOLD-UNTIL-2099-01-01" }],
    };

    const out = await service.reconcileHeldStillOnCampaigns({
      accounts: [tagged] as never,
      campaignStatus: new Map([[10, "ACTIVE"]]),
      dryRun: false,
    });

    assert.equal(out.stillActive, 1);
    assert.deepEqual(removed, [[10, [1]]]);
  });

  it("pauses a campaign before removing its last account", async () => {
    const { service, paused, removed } = fixture({
      heldEmails: ["last@x.com"],
      campaignMembers: { 10: [{ id: 1 }] },
    });

    await service.reconcileHeldStillOnCampaigns({
      accounts: [account("last@x.com", [10])] as never,
      campaignStatus: new Map([[10, "ACTIVE"]]),
      dryRun: false,
    });

    assert.deepEqual(paused, [10], "must pause before stripping the last account");
    assert.deepEqual(removed, [[10, [1]]]);
  });

  it("writes nothing on a dry run", async () => {
    const { service, removed, paused } = fixture({ heldEmails: ["stuck@x.com"] });

    const out = await service.reconcileHeldStillOnCampaigns({
      accounts: [account("stuck@x.com", [10])] as never,
      campaignStatus: new Map([[10, "ACTIVE"]]),
      dryRun: true,
    });

    assert.equal(out.stillActive, 1);
    assert.equal(out.repulled.length, 1);
    assert.deepEqual(removed, []);
    assert.deepEqual(paused, []);
  });

  it("will not take a campaign below the D7 floor in one pass", async () => {
    // Floor 2. Campaign 10 has 3 senders, all held. Only one may come off
    // this pass; the rest wait for top-up to refill.
    const removed: Array<[number, number[]]> = [];
    const state = {
      getHeldInbox: (email: string) => heldRecord(email),
      getRestingInbox: () => undefined,
      listRestingInboxes: () => [],
      markPendingResume: () => undefined,
    } as unknown as StateStore;
    const smartlead = {
      getCampaignEmailAccounts: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
      removeEmailAccountsFromCampaign: async (id: number, ids: number[]) => {
        removed.push([id, [...ids]]);
      },
      updateCampaignStatus: async () => undefined,
    } as unknown as SmartleadClient;
    const service = new RemediationService(
      loadConfig({ MIN_CAMPAIGN_SENDERS: "2" }),
      smartlead,
      {} as unknown as SmartDeliveryClient,
      null,
      { send: async () => undefined } as unknown as SlackClient,
      state,
      undefined as never,
    );

    const out = await service.reconcileHeldStillOnCampaigns({
      accounts: [
        { id: 1, from_email: "a@x.com", campaign_ids: [10], tags: [] },
        { id: 2, from_email: "b@x.com", campaign_ids: [10], tags: [] },
        { id: 3, from_email: "c@x.com", campaign_ids: [10], tags: [] },
      ] as never,
      campaignStatus: new Map([[10, "ACTIVE"]]),
      dryRun: false,
    });

    assert.equal(removed.length, 1, "only one removal before hitting the floor");
    assert.equal(out.deferredForFloor, 2);
  });

  it("still re-pulls from a campaign already under the floor", async () => {
    // Already below floor — keeping a benched sender there does not help it.
    const removed: Array<[number, number[]]> = [];
    const state = {
      getHeldInbox: (email: string) => heldRecord(email),
      getRestingInbox: () => undefined,
      listRestingInboxes: () => [],
      markPendingResume: () => undefined,
    } as unknown as StateStore;
    const smartlead = {
      getCampaignEmailAccounts: async () => [{ id: 1 }, { id: 9 }],
      removeEmailAccountsFromCampaign: async (id: number, ids: number[]) => {
        removed.push([id, [...ids]]);
      },
      updateCampaignStatus: async () => undefined,
    } as unknown as SmartleadClient;
    const service = new RemediationService(
      loadConfig({ MIN_CAMPAIGN_SENDERS: "50" }),
      smartlead,
      {} as unknown as SmartDeliveryClient,
      null,
      { send: async () => undefined } as unknown as SlackClient,
      state,
      undefined as never,
    );

    const out = await service.reconcileHeldStillOnCampaigns({
      accounts: [
        { id: 1, from_email: "a@x.com", campaign_ids: [10], tags: [] },
      ] as never,
      campaignStatus: new Map([[10, "ACTIVE"]]),
      dryRun: false,
    });

    assert.equal(out.deferredForFloor, 0);
    assert.deepEqual(removed, [[10, [1]]]);
  });

  it("reports a failed re-pull instead of silently dropping it", async () => {
    const { service } = fixture({
      heldEmails: ["stuck@x.com"],
      failRemoval: true,
    });

    const out = await service.reconcileHeldStillOnCampaigns({
      accounts: [account("stuck@x.com", [10])] as never,
      campaignStatus: new Map([[10, "ACTIVE"]]),
      dryRun: false,
    });

    assert.equal(out.repulled.length, 0);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0] ?? "", /stuck@x\.com.*campaign 10/);
  });
});
