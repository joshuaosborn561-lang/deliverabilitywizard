import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { StateStore } from "../state/store.js";
import { CampaignHealthService } from "./campaignHealth.js";
import { CampaignTopUpService } from "./campaignTopUp.js";

function fakeSlack(): SlackClient {
  return { send: async () => undefined } as unknown as SlackClient;
}

describe("CampaignHealthService", () => {
  it("resumes a pending campaign once staffable floor is met", async () => {
    const pending = new Map<number, { campaignId: number; reason: string; pausedAt: string }>([
      [
        9,
        {
          campaignId: 9,
          reason: "warmup_gate_last_account",
          pausedAt: new Date().toISOString(),
        },
      ],
    ]);
    const state = {
      listPoolMailboxes: () => [],
      listActiveSwaps: () => [],
      findReassignablePoolMailbox: () => undefined,
      getHeldInbox: () => undefined,
      getRestingInbox: () => undefined,
      getPoolMailbox: () => undefined,
      clearGenericSendStartedAt: () => undefined,
      isCopyCanary: () => false,
      hasPendingResume: (id: number) => pending.has(id),
      listPendingResumes: () => [...pending.values()],
      clearPendingResume: (id: number) => {
        pending.delete(id);
      },
      markPendingResume: () => undefined,
      setLastHealthAt: () => undefined,
      save: async () => undefined,
      upsertPoolMailbox: () => undefined,
    } as unknown as StateStore;

    const staffed = Array.from({ length: 50 }, (_, index) => ({
      id: 100 + index,
      from_email: `ok-${index}@pool.info`,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      campaign_ids: [9],
    }));

    let started = false;
    const smartlead = {
      listCampaigns: async () => [
        { id: 9, name: "Paused Thin", status: "PAUSED", client_id: 1 },
      ],
      listAllEmailAccounts: async () => staffed,
      listClients: async () => [{ id: 1, name: "Client" }],
      updateCampaignStatus: async (_id: number, status: string) => {
        if (status === "START") started = true;
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const config = loadConfig({
      MIN_CAMPAIGN_SENDERS: "50",
      ENABLE_CAMPAIGN_TOP_UP: "true",
    });
    const topUp = new CampaignTopUpService(config, smartlead, fakeSlack(), state);
    const health = new CampaignHealthService(
      config,
      smartlead,
      fakeSlack(),
      state,
      topUp,
    );

    const result = await health.run({ dryRun: false });
    assert.equal(started, true);
    assert.equal(result.resumed.length, 1);
    assert.equal(result.resumed[0]?.campaignId, 9);
    assert.equal(pending.size, 0);
    assert.equal(result.stillShort.length, 0);
    assert.equal(result.fanOutAttached, 0);
  });

  it("does not count disconnected membership toward the floor", async () => {
    const state = {
      listPoolMailboxes: () => [],
      listActiveSwaps: () => [],
      findReassignablePoolMailbox: () => undefined,
      getHeldInbox: () => undefined,
      getRestingInbox: () => undefined,
      getPoolMailbox: () => undefined,
      clearGenericSendStartedAt: () => undefined,
      isCopyCanary: () => false,
      hasPendingResume: () => false,
      listPendingResumes: () => [],
      clearPendingResume: () => undefined,
      setLastHealthAt: () => undefined,
      save: async () => undefined,
      upsertPoolMailbox: () => undefined,
    } as unknown as StateStore;

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Active", status: "ACTIVE", client_id: 1 },
      ],
      listAllEmailAccounts: async () =>
        Array.from({ length: 50 }, (_, index) => ({
          id: index + 1,
          from_email: `dead-${index}@x.com`,
          client_id: 1,
          type: "GMAIL",
          is_smtp_success: false,
          is_imap_success: false,
          campaign_ids: [1],
        })),
      listClients: async () => [{ id: 1, name: "Client" }],
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const config = loadConfig({
      MIN_CAMPAIGN_SENDERS: "50",
      ENABLE_CAMPAIGN_TOP_UP: "true",
    });
    const topUp = new CampaignTopUpService(config, smartlead, fakeSlack(), state);
    const health = new CampaignHealthService(
      config,
      smartlead,
      fakeSlack(),
      state,
      topUp,
    );

    const result = await health.run({ dryRun: true });
    assert.equal(result.snapshots[0]?.membership, 50);
    assert.equal(result.snapshots[0]?.staffable, 0);
    assert.equal(result.snapshots[0]?.floor, 25);
    assert.equal(result.snapshots[0]?.needed, 25);
    assert.equal(result.stillShort[0]?.shortBy, 25);
  });

  it("does not auto-START a STOPPED campaign even with pendingResume (D40)", async () => {
    const pending = new Map<number, { campaignId: number; reason: string; pausedAt: string }>([
      [
        11,
        {
          campaignId: 11,
          reason: "warmup_gate_last_account",
          pausedAt: new Date().toISOString(),
        },
      ],
    ]);
    const state = {
      listPoolMailboxes: () => [],
      listActiveSwaps: () => [],
      findReassignablePoolMailbox: () => undefined,
      getHeldInbox: () => undefined,
      getRestingInbox: () => undefined,
      getPoolMailbox: () => undefined,
      clearGenericSendStartedAt: () => undefined,
      isCopyCanary: () => false,
      hasPendingResume: (id: number) => pending.has(id),
      listPendingResumes: () => [...pending.values()],
      clearPendingResume: (id: number) => {
        pending.delete(id);
      },
      markPendingResume: () => undefined,
      setLastHealthAt: () => undefined,
      save: async () => undefined,
      upsertPoolMailbox: () => undefined,
    } as unknown as StateStore;

    const staffed = Array.from({ length: 50 }, (_, index) => ({
      id: 200 + index,
      from_email: `ok-${index}@pool.info`,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      campaign_ids: [11],
    }));

    let started = false;
    const smartlead = {
      listCampaigns: async () => [
        { id: 11, name: "Operator stopped", status: "STOPPED", client_id: 1 },
      ],
      listAllEmailAccounts: async () => staffed,
      listClients: async () => [{ id: 1, name: "Client" }],
      updateCampaignStatus: async (_id: number, status: string) => {
        if (status === "START") started = true;
      },
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const config = loadConfig({
      MIN_CAMPAIGN_SENDERS: "50",
      ENABLE_CAMPAIGN_TOP_UP: "false",
    });
    const topUp = new CampaignTopUpService(config, smartlead, fakeSlack(), state);
    const health = new CampaignHealthService(
      config,
      smartlead,
      fakeSlack(),
      state,
      topUp,
    );

    const result = await health.run({ dryRun: false });
    assert.equal(started, false);
    assert.equal(result.resumed.length, 0);
    assert.equal(pending.size, 0);
  });
});
