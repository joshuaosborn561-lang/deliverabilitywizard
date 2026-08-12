import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import {
  CampaignSettingsGuardService,
  DESIRED_AI_CATEGORY_IDS,
} from "./campaignSettingsGuard.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";

describe("campaignSettingsGuard", () => {
  it("writes bounce 5%, AI cats 1/3/6, and OOO auto-categorize", async () => {
    const writes: Array<{ id: number; body: Record<string, unknown> }> = [];
    const smartlead = {
      listCampaigns: async () => [
        {
          id: 10,
          name: "Dave Ackley Goliath L1",
          status: "ACTIVE",
          client_id: 548611,
        },
        {
          id: 11,
          name: "Orphan Draft",
          status: "DRAFTED",
          client_id: null,
        },
      ],
      listClients: async () => [{ id: 548611, name: "Dave Ackley" }],
      updateCampaignSettings: async (id: number, body: Record<string, unknown>) => {
        writes.push({ id, body });
        return { ok: true };
      },
    } as unknown as SmartleadClient;

    const slackMessages: string[] = [];
    const slack = {
      send: async (msg: string) => {
        slackMessages.push(msg);
      },
    } as unknown as SlackClient;

    const config = loadConfig({
      ENABLE_CAMPAIGN_SETTINGS_GUARD: "true",
      CAMPAIGN_BOUNCE_AUTOPAUSE_THRESHOLD: "5",
      DRY_RUN: "false",
    } as NodeJS.ProcessEnv);

    const result = await new CampaignSettingsGuardService(
      config,
      smartlead,
      slack,
    ).run();

    assert.equal(result.scanned, 2);
    assert.equal(result.settingsApplied, 2);
    assert.ok(result.clientsMissing.some((c) => c.campaignId === 11));
    assert.ok(slackMessages.some((m) => /missing a Smartlead client/i.test(m)));

    const settingsWrite = writes.find(
      (w) => w.id === 10 && w.body.bounce_autopause_threshold,
    );
    assert.ok(settingsWrite);
    assert.equal(settingsWrite!.body.bounce_autopause_threshold, "5");
    assert.deepEqual(
      settingsWrite!.body.ai_categorisation_options,
      DESIRED_AI_CATEGORY_IDS,
    );
    const ooo = settingsWrite!.body
      .out_of_office_detection_settings as Record<string, unknown>;
    assert.equal(ooo.autoCategorizeOOO, true);
    assert.equal(ooo.autoReactivateOOO, false);
    assert.equal(ooo.reactivateOOOwithDelay, 0);
  });

  it("assigns a matched client before writing settings", async () => {
    const writes: Array<{ id: number; body: Record<string, unknown> }> = [];
    const smartlead = {
      listCampaigns: async () => [
        {
          id: 20,
          name: "Goliath L9 New",
          status: "ACTIVE",
          client_id: null,
        },
        {
          id: 21,
          name: "Goliath L1",
          status: "ACTIVE",
          client_id: 548611,
        },
      ],
      listClients: async () => [{ id: 548611, name: "Dave Ackley" }],
      updateCampaignSettings: async (id: number, body: Record<string, unknown>) => {
        writes.push({ id, body });
        return { ok: true };
      },
    } as unknown as SmartleadClient;

    const slack = { send: async () => undefined } as unknown as SlackClient;
    const config = loadConfig({
      ENABLE_CAMPAIGN_SETTINGS_GUARD: "true",
      DRY_RUN: "false",
    } as NodeJS.ProcessEnv);

    const result = await new CampaignSettingsGuardService(
      config,
      smartlead,
      slack,
    ).run();

    assert.equal(result.clientsAssigned, 1);
    assert.ok(
      writes.some((w) => w.id === 20 && w.body.client_id === 548611),
    );
  });
});
