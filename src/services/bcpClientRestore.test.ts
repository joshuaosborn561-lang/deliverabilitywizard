import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import { StateStore } from "../state/store.js";
import { BcpClientRestoreService } from "./bcpClientRestore.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("BcpClientRestoreService", () => {
  it("dry-run restores held BCP domains without stripping generics (D27)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bcp-restore-"));
    const state = new StateStore(path.join(dir, "state.json"));
    await state.load();

    state.upsertPoolMailbox({
      email: "breanna@crossscaleco.com",
      firstName: "Breanna",
      lastName: "Escobar",
      platform: "GOOGLE",
      status: "assigned",
      smartleadAccountId: 99,
      prewarmed: true,
    });
    state.markHeldInbox({
      accountId: 11,
      email: "alex@boldercyperpartnerhub.info",
      heldAt: "2026-08-05T00:00:00.000Z",
      holdUntil: "2026-08-19",
      removedFromCampaigns: [3763800],
    });
    state.markSwap({
      originalEmail: "alex@boldercyperpartnerhub.info",
      originalAccountId: 11,
      poolEmail: "breanna@crossscaleco.com",
      poolAccountId: 99,
      clientId: 1,
      clientName: "Bolder Cyber Partners (Mike Trpkosh)",
      campaignIds: [3763800],
      swappedAt: "2026-08-05T00:00:00.000Z",
      poolPlatform: "GOOGLE",
    });

    const removed: Array<{ campaignId: number; ids: number[] }> = [];
    const added: Array<{ campaignId: number; ids: number[] }> = [];

    const service = new BcpClientRestoreService(
      loadConfig({}),
      {
        listCampaigns: async () => [
          {
            id: 3763800,
            name: "BCP Healthcare Under-1k (No Team)",
            status: "ACTIVE",
          },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 99,
            from_email: "breanna@crossscaleco.com",
            from_name: "Breanna Escobar",
            campaign_ids: [3763800],
          },
          {
            id: 11,
            from_email: "alex@boldercyperpartnerhub.info",
            campaign_ids: [],
          },
        ],
        removeEmailAccountsFromCampaign: async (
          campaignId: number,
          ids: number[],
        ) => {
          removed.push({ campaignId, ids });
        },
        addEmailAccountsToCampaign: async (
          campaignId: number,
          ids: number[],
        ) => {
          added.push({ campaignId, ids });
        },
        updateEmailAccount: async () => undefined,
        getEmailAccount: async () => ({ id: 11, tags: [] }),
        removeTags: async () => undefined,
      } as unknown as SmartleadClient,
      {
        listTests: async () => [],
        enrichCampaignIds: async <T,>(t: T[]) => t,
      } as unknown as SmartDeliveryClient,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(
      result.genericsRemoved.length,
      0,
      "D27: generics stay on BCP",
    );
    assert.equal(result.originalsRestored.length, 1);
    assert.equal(
      result.originalsRestored[0]?.email,
      "alex@boldercyperpartnerhub.info",
    );
    assert.equal(removed.length, 0, "dry-run must not write Smartlead");
    assert.equal(added.length, 0);
    assert.equal(result.swapsCleared, 1);

    await rm(dir, { recursive: true, force: true });
  });
});
