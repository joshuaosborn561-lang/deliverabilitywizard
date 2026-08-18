import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartleadClientRecord } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { RecoveryPoolService } from "./recoveryPool.js";

/**
 * Reproduces production:
 *   remediation: swap rachel.collins27@useroofsbypeterson.info: unknown ESP type (SMTP)
 *
 * Smartlead typed the Workspace mailbox as SMTP; ESP matching must fall back
 * to the domain's MX/SPF (smtp.google.com / _spf.google.com → GOOGLE).
 */
describe("RecoveryPoolService SMTP ESP fallback", () => {
  async function fixture() {
    const state = new StateStore(
      `/tmp/recovery-pool-${process.pid}-${Date.now()}-${Math.random()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "generic@pool.info",
      domain: "pool.info",
      platform: "GOOGLE",
      smartleadAccountId: 99,
      firstName: "Harmony",
      lastName: "Norris",
      status: "available",
      warmedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      availableAt: new Date().toISOString(),
    });
    return state;
  }

  function config() {
    return loadConfig({
      ENABLE_RECOVERY_POOL: "true",
      POOL_WARMUP_DAYS: "14",
    });
  }

  function slack(): SlackClient {
    return { send: async () => undefined } as unknown as SlackClient;
  }

  it("swaps an SMTP-typed Google Workspace mailbox via DNS ESP inference", async () => {
    const state = await fixture();
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const adds: Array<{ campaignId: number; ids: number[] }> = [];
    const smartlead = {
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        adds.push({ campaignId, ids });
      },
    } as unknown as SmartleadClient;

    const service = new RecoveryPoolService(
      config(),
      smartlead,
      slack(),
      state,
      async () => ({
        mx: ["smtp.google.com"],
        txt: ["v=spf1 include:_spf.google.com ~all"],
      }),
    );

    const clientsById = new Map<number, SmartleadClientRecord>([
      [7, { id: 7, name: "Roofs By Peterson" }],
    ]);

    const result = await service.run({
      accounts: [
        {
          id: 42,
          from_email: "rachel.collins27@useroofsbypeterson.info",
          from_name: "Rachel Collins",
          type: "SMTP",
          client_id: 7,
          campaign_ids: [100],
        },
        {
          id: 99,
          from_email: "generic@pool.info",
          from_name: "Harmony Norris",
          type: "GMAIL",
          campaign_ids: [],
        },
      ],
      newlyHeld: [
        {
          accountId: 42,
          email: "rachel.collins27@useroofsbypeterson.info",
          removedFromCampaigns: [100],
          clientId: 7,
          clientName: "Roofs By Peterson",
          type: "SMTP",
          fromName: "Rachel Collins",
        },
      ],
      recoveredOriginals: [],
      dryRun: false,
      campaignClientById: new Map([[100, 7]]),
      clientsById,
    });

    assert.equal(result.errors.length, 0, result.errors.join("; "));
    assert.equal(result.swaps.length, 1);
    assert.equal(result.swaps[0]?.platform, "GOOGLE");
    assert.equal(result.swaps[0]?.poolEmail, "generic@pool.info");
    assert.equal(adds.length, 1);
    assert.equal(updates.length, 1);
  });

  it("still errors when SMTP domain DNS has no Google/Microsoft signal", async () => {
    const state = await fixture();
    const smartlead = {
      updateEmailAccount: async () => undefined,
      addEmailAccountsToCampaign: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new RecoveryPoolService(
      config(),
      smartlead,
      slack(),
      state,
      async () => ({
        mx: ["mail.other-host.com"],
        txt: ["v=spf1 a mx ~all"],
      }),
    );

    const result = await service.run({
      accounts: [
        {
          id: 42,
          from_email: "rachel.collins27@useroofsbypeterson.info",
          type: "SMTP",
          campaign_ids: [100],
        },
      ],
      newlyHeld: [
        {
          accountId: 42,
          email: "rachel.collins27@useroofsbypeterson.info",
          removedFromCampaigns: [100],
          type: "SMTP",
        },
      ],
      recoveredOriginals: [],
      dryRun: true,
      campaignClientById: new Map(),
      clientsById: new Map(),
    });

    assert.equal(result.swaps.length, 0);
    assert.match(
      result.errors[0] ?? "",
      /unknown ESP type \(SMTP\)/i,
    );
  });
});
