import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { ManualRotationService } from "./manualRotation.js";

async function fixture(opts: { poolStatus?: "available" | "warming" } = {}) {
  const state = new StateStore(
    `/tmp/manual-rotation-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await state.load();
  state.upsertPoolMailbox({
    email: "generic@pool.info",
    domain: "pool.info",
    platform: "MICROSOFT",
    smartleadAccountId: 20,
    firstName: "Amina",
    lastName: "Patel",
    status: opts.poolStatus ?? "available",
    warmedAt:
      opts.poolStatus === "warming"
        ? new Date().toISOString()
        : new Date(Date.now() - 20 * 86_400_000).toISOString(),
  });
  const campaigns = [
    { id: 1, name: "Client Campaign", status: "ACTIVE", client_id: 7 },
  ];
  const accounts = [
    {
      id: 10,
      from_email: "original@client.info",
      from_name: "Original Sender",
      type: "OUTLOOK",
      client_id: 7,
      campaign_ids: [1],
    },
    {
      id: 20,
      from_email: "generic@pool.info",
      from_name: "Amina Patel",
      signature: "Amina Patel",
      type: "OUTLOOK",
      client_id: null,
      campaign_ids: [],
    },
  ];
  return { state, campaigns, accounts };
}

function config() {
  return loadConfig({
    ENABLE_RECOVERY_POOL: "true",
    RECOVERY_HOLD_DAYS: "14",
    MESSAGE_PER_DAY: "30",
  });
}

function slack(): SlackClient {
  return { send: async () => undefined } as unknown as SlackClient;
}

describe("ManualRotationService", () => {
  it("previews only an idle, warmed, ESP-matched generic", async () => {
    const { state, campaigns, accounts } = await fixture();
    const smartlead = {
      listCampaigns: async () => campaigns,
      listAllEmailAccounts: async () => accounts,
      listClients: async () => [{ id: 7, name: "Client Seven" }],
    } as unknown as SmartleadClient;
    const service = new ManualRotationService(
      config(),
      smartlead,
      slack(),
      state,
    );

    const preview = await service.preview("original@client.info");
    assert.equal(preview.allowed, true);
    assert.equal(preview.replacement?.email, "generic@pool.info");
    assert.equal(preview.platform, "MICROSOFT");
    assert.equal(preview.campaigns[0]?.id, 1);
  });

  it("blocks rotation when the matching generic is still warming", async () => {
    const { state, campaigns, accounts } = await fixture({
      poolStatus: "warming",
    });
    const smartlead = {
      listCampaigns: async () => campaigns,
      listAllEmailAccounts: async () => accounts,
      listClients: async () => [{ id: 7, name: "Client Seven" }],
    } as unknown as SmartleadClient;
    const service = new ManualRotationService(
      config(),
      smartlead,
      slack(),
      state,
    );
    const preview = await service.preview("original@client.info");
    assert.equal(preview.allowed, false);
    assert.match(preview.reasons.join(" "), /fully warmed/i);
  });

  it("blocks a pre-warmed fleet identity even if state registration is missing", async () => {
    const { state, campaigns, accounts } = await fixture();
    accounts[0]!.from_name = "Harmony Norris";
    const smartlead = {
      listCampaigns: async () => campaigns,
      listAllEmailAccounts: async () => accounts,
      listClients: async () => [{ id: 7, name: "Client Seven" }],
    } as unknown as SmartleadClient;
    const service = new ManualRotationService(
      loadConfig({
        ENABLE_RECOVERY_POOL: "true",
        EXTRA_GENERIC_MAILBOXES: "harmony norris",
      }),
      smartlead,
      slack(),
      state,
    );
    const preview = await service.preview("original@client.info");
    assert.equal(preview.allowed, false);
    assert.match(preview.reasons.join(" "), /pre-warmed generic fleet/i);
  });

  it("compensates campaign and identity writes when execution fails", async () => {
    const { state, campaigns, accounts } = await fixture();
    const events: string[] = [];
    const smartlead = {
      listCampaigns: async () => campaigns,
      listAllEmailAccounts: async () => accounts,
      listClients: async () => [{ id: 7, name: "Client Seven" }],
      getEmailAccount: async () => accounts[1],
      ensureHoldUntilTag: async () => ({ id: 99, name: "HOLD-UNTIL" }),
      configureWarmup: async () => undefined,
      setDailySendLimit: async () => undefined,
      updateEmailAccount: async (
        _id: number,
        fields: { signature?: string },
      ) => {
        events.push(`identity:${fields.signature}`);
      },
      addEmailAccountsToCampaign: async (campaignId: number) => {
        events.push(`add:${campaignId}`);
      },
      removeEmailAccountsFromCampaign: async (campaignId: number, ids: number[]) => {
        events.push(`remove:${campaignId}:${ids[0]}`);
        if (ids[0] === 10) throw new Error("Smartlead remove failed");
      },
      removeTags: async () => undefined,
    } as unknown as SmartleadClient;
    const service = new ManualRotationService(
      config(),
      smartlead,
      slack(),
      state,
    );

    const result = await service.execute("original@client.info");
    assert.equal(result.completed, false);
    assert.equal(result.rolledBack, true);
    assert.ok(events.includes("add:1"));
    assert.ok(events.includes("remove:1:20"));
    assert.equal(state.getPoolMailbox("generic@pool.info")?.status, "available");
    assert.equal(state.getSwap("original@client.info"), undefined);
  });

  it("releases only stale reservations proven idle in Smartlead", async () => {
    const { state } = await fixture();
    state.upsertPoolMailbox({
      ...state.getPoolMailbox("generic@pool.info")!,
      status: "provisioning",
      assignedToEmail: "original@client.info",
      assignedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const smartlead = {
      getEmailAccount: async () => ({
        id: 20,
        from_email: "generic@pool.info",
        campaign_ids: [],
      }),
    } as unknown as SmartleadClient;
    const service = new ManualRotationService(
      config(),
      smartlead,
      slack(),
      state,
    );
    const recovered = await service.recoverStaleReservations();
    assert.deepEqual(recovered.released, ["generic@pool.info"]);
    assert.equal(state.getPoolMailbox("generic@pool.info")?.status, "available");
  });
});
