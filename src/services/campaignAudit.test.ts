import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import { StateStore } from "../state/store.js";
import { CampaignAuditService } from "./campaignAudit.js";

describe("CampaignAuditService signature QA", () => {
  it("flags a foreign-brand mailbox signature on a live campaign (D74)", async () => {
    const state = new StateStore(
      `/tmp/campaign-audit-sig-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const service = new CampaignAuditService(
      loadConfig({}),
      {
        listCampaigns: async () => [
          {
            id: 3815447,
            name: "Goliath Displacement M",
            status: "ACTIVE",
            client_id: 548611,
          },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "aarav@pool.info",
            from_name: "Aarav Sanchez",
            signature: "Aarav Sanchez\nRoofs by Peterson",
            client_id: 548611,
            campaign_ids: [3815447],
            is_smtp_success: true,
            is_imap_success: true,
          },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
          { id: 99, name: "Peterson", logo: "Roofs by Peterson" },
        ],
        getCampaignSequences: async () => [
          {
            id: 1,
            seq_number: 1,
            email_body: "<div>The screenshots are the part IT teams thank us for.</div><div>%signature%</div>",
            sequence_variants: [
              {
                variant_label: "A",
                email_body:
                  "<div>The screenshots are the part IT teams thank us for.</div><div>%signature%</div>",
              },
            ],
          },
        ],
      } as unknown as SmartleadClient,
      {
        listTests: async () => [],
        enrichCampaignIds: async (rows: unknown[]) => rows,
      } as unknown as SmartDeliveryClient,
      state,
    );

    const result = await service.run(50);
    assert.ok(
      result.signatureIssues.some(
        (issue) =>
          issue.kind === "mailbox_sig" &&
          issue.detail.includes("Roofs by Peterson") &&
          issue.detail.includes("aarav@pool.info"),
      ),
      "QA must catch a Peterson signature on Goliath",
    );
  });

  it("flags an empty mailbox signature on a live campaign (D31)", async () => {
    const state = new StateStore(
      `/tmp/campaign-audit-sig-empty-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const service = new CampaignAuditService(
      loadConfig({}),
      {
        listCampaigns: async () => [
          {
            id: 3815447,
            name: "Goliath Displacement M",
            status: "ACTIVE",
            client_id: 548611,
          },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "aarav@pool.info",
            from_name: "Aarav Sanchez",
            signature: "",
            client_id: 548611,
            campaign_ids: [3815447],
            is_smtp_success: true,
            is_imap_success: true,
          },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        ],
        getCampaignSequences: async () => [
          {
            id: 1,
            seq_number: 1,
            email_body:
              "<div>The screenshots are the part IT teams thank us for.</div><div>%signature%</div>",
          },
        ],
      } as unknown as SmartleadClient,
      {
        listTests: async () => [],
        enrichCampaignIds: async (rows: unknown[]) => rows,
      } as unknown as SmartDeliveryClient,
      state,
    );

    const result = await service.run(50);
    assert.ok(
      result.signatureIssues.some(
        (issue) =>
          issue.kind === "mailbox_sig" &&
          issue.detail.includes("aarav@pool.info") &&
          issue.detail.includes("no signature"),
      ),
      "QA must catch an empty mailbox signature",
    );
  });
});
