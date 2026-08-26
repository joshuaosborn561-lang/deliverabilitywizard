import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { StateStore } from "../state/store.js";
import { isBcpCampaignName } from "../lib/bcp.js";
import { PlacementAuditService } from "./placementAudit.js";

describe("isBcpCampaignName", () => {
  it("matches BCP campaign titles", () => {
    assert.equal(isBcpCampaignName("BCP Generic (No Team)"), true);
    assert.equal(isBcpCampaignName("BCP Logistics"), true);
    assert.equal(isBcpCampaignName("TechEvo New England"), false);
  });
});

describe("PlacementAuditService", () => {
  it("flags missing spam_assassin and oversized batches", async () => {
    const config = loadConfig({});
    const slackMessages: string[] = [];
    const smartDelivery = {
      listTests: async () => [
        {
          spam_test_id: "501",
          every_days: 1,
          status: "ACTIVE",
          campaign_id: 1,
          test_name: "Auto: BCP",
        },
      ],
      enrichCampaignIds: async <T,>(tests: T[]) => tests,
      getTestDetails: async () => ({
        spam_filters: [],
        link_checker: false,
        every_days: 1,
        provider_ids: [1, 2],
        sender_accounts: Array.from({ length: 51 }, (_, i) => ({
          from_email: `s${i}@boldercyperpartner.info`,
          type: i % 2 === 0 ? "GMAIL" : "OUTLOOK",
        })),
      }),
    } as unknown as SmartDeliveryClient;

    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "BCP Generic", status: "ACTIVE" },
        { id: 2, name: "Untested Active", status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;

    const service = new PlacementAuditService(
      config,
      smartlead,
      smartDelivery,
      {
        send: async (text: string) => {
          slackMessages.push(text);
        },
      } as unknown as SlackClient,
      {
        getPoolMailbox: () => undefined,
      } as unknown as StateStore,
    );

    const result = await service.runPlacements();
    assert.equal(result.checked, 1);
    assert.equal(result.ok, 0);
    assert.ok(
      result.drift.some((d) => d.kind === "missing_spam_assassin"),
    );
    assert.ok(result.drift.some((d) => d.kind === "link_checker_off"));
    assert.ok(result.drift.some((d) => d.kind === "over_max_senders"));
    assert.equal(result.untestedActiveCampaigns.length, 1);
    assert.equal(result.untestedActiveCampaigns[0]?.id, "2");
    assert.ok(slackMessages.length >= 1);
  });

  it("reports BCP generics from the pool", async () => {
    const config = loadConfig({});
    const service = new PlacementAuditService(
      config,
      {
        listCampaigns: async () => [
          { id: 9, name: "BCP Generic (No Team)", status: "ACTIVE" },
          { id: 8, name: "TechEvo", status: "ACTIVE" },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 1,
            from_email: "a@crossscaleco.com",
            from_name: "Breanna Escobar",
            campaign_ids: [9],
          },
          {
            id: 2,
            from_email: "b@boldercyperpartner.info",
            campaign_ids: [9],
          },
        ],
      } as unknown as SmartleadClient,
      {} as SmartDeliveryClient,
      { send: async () => undefined } as unknown as SlackClient,
      {
        getPoolMailbox: (email: string) =>
          email === "a@crossscaleco.com"
            ? { email, status: "assigned", prewarmed: true }
            : undefined,
      } as unknown as StateStore,
    );

    const result = await service.runBcpGenerics();
    assert.equal(result.bcpCampaigns.length, 1);
    assert.ok(
      result.genericHits.some(
        (h) =>
          h.email === "a@crossscaleco.com" &&
          (h.reason === "pool" || h.reason === "prewarmed_domain"),
      ),
    );
    assert.ok(
      !result.genericHits.some((h) => h.email === "b@boldercyperpartner.info"),
    );
  });
});
