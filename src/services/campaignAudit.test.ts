import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import { StateStore } from "../state/store.js";
import { CampaignAuditService } from "./campaignAudit.js";
import type { InventoryBook } from "./inventory.js";

/** D132 — a test book reading the same fake client, one attempt, clients optional. */
function bookOf(sl: unknown): InventoryBook {
  const client = sl as {
    listCampaigns?: () => Promise<unknown[]>;
    listAllEmailAccounts?: (o?: unknown) => Promise<unknown[]>;
    listClients?: () => Promise<unknown[]>;
  };
  return {
    get: async () => ({
      campaigns:
        typeof client.listCampaigns === "function"
          ? await client.listCampaigns()
          : [],
      accounts:
        typeof client.listAllEmailAccounts === "function"
          ? await client.listAllEmailAccounts({ fetchCampaigns: true })
          : [],
      clients:
        typeof client.listClients === "function"
          ? await client.listClients().catch(() => [])
          : [],
      fetchedAt: Date.now(),
    }),
  } as unknown as InventoryBook;
}

function mkAudit(
  ...args: [
    ConstructorParameters<typeof CampaignAuditService>[0],
    ConstructorParameters<typeof CampaignAuditService>[1],
    ConstructorParameters<typeof CampaignAuditService>[2],
    ConstructorParameters<typeof CampaignAuditService>[3],
  ]
): CampaignAuditService {
  const [config, sl, sd, state] = args;
  return new CampaignAuditService(config, sl, sd, state, bookOf(sl));
}

describe("CampaignAuditService signature QA", () => {
  it("flags a foreign-brand mailbox signature on a live campaign (D74)", async () => {
    const state = new StateStore(
      `/tmp/campaign-audit-sig-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const service = mkAudit(
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
    const service = mkAudit(
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

  it("D177: does not flag missing %signature% when copy contains Insight", async () => {
    const state = new StateStore(
      `/tmp/campaign-audit-insight-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const service = mkAudit(
      loadConfig({}),
      {
        listCampaigns: async () => [
          {
            id: 3921647,
            name: "SalesGlider tagged draft",
            status: "ACTIVE",
            client_id: 345263,
          },
          {
            id: 88,
            name: "SalesGlider Nurture",
            status: "ACTIVE",
            client_id: 345263,
          },
        ],
        listAllEmailAccounts: async () => [],
        listClients: async () => [
          { id: 345263, name: "SalesGlider", logo: "SalesGlider" },
        ],
        getCampaignSequences: async (id: number) => [
          {
            seq_number: 1,
            email_body:
              id === 3921647
                ? "<div>A note from Insight this week</div>"
                : "<div>no tag on purpose</div>",
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
    assert.equal(
      result.signatureIssues.some(
        (issue) =>
          issue.campaignId === 3921647 &&
          issue.kind === "missing_signature_tag",
      ),
      false,
      "Insight-in-copy must not be a missing_signature_tag finding",
    );
    assert.ok(
      result.signatureIssues.some(
        (issue) =>
          issue.campaignId === 88 && issue.kind === "missing_signature_tag",
      ),
      "SalesGlider still flags a missing tag",
    );
  });

  it("D184: flags SalesGlider under an Insight close; empty Insight mailbox is fine", async () => {
    const state = new StateStore(
      `/tmp/campaign-audit-insight-dual-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const service = mkAudit(
      loadConfig({}),
      {
        listCampaigns: async () => [
          {
            id: 3921647,
            name: "Insight Consolidation Gateway SEG",
            status: "ACTIVE",
            client_id: 345263,
          },
          {
            id: 89,
            name: "SalesGlider Nurture",
            status: "ACTIVE",
            client_id: 345263,
          },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "joshua@salesglidertop.org",
            from_name: "Joshua Osborn",
            signature: "Joshua Osborn\nSalesGlider",
            client_id: 345263,
            campaign_ids: [3921647],
            is_smtp_success: true,
            is_imap_success: true,
          },
          {
            id: 12,
            from_email: "clean@salesglidertop.org",
            from_name: "Joshua Osborn",
            signature: "",
            client_id: 345263,
            campaign_ids: [3921647],
            is_smtp_success: true,
            is_imap_success: true,
          },
          {
            id: 13,
            from_email: "shared@salesglidertop.org",
            from_name: "Joshua Osborn",
            signature: "Joshua Osborn\nSalesGlider",
            client_id: 345263,
            campaign_ids: [3921647, 89],
            is_smtp_success: true,
            is_imap_success: true,
          },
        ],
        listClients: async () => [
          { id: 345263, name: "SalesGlider", logo: "SalesGlider" },
        ],
        getCampaignSequences: async () => [
          {
            seq_number: 1,
            email_body:
              "<div>A note from Insight</div><div>Josh Osborn</div><div>Insight</div>",
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
          issue.campaignId === 3921647 &&
          issue.kind === "mailbox_sig" &&
          issue.detail.includes("joshua@salesglidertop.org") &&
          /SalesGlider/.test(issue.detail),
      ),
      "QA must flag SalesGlider under an Insight close",
    );
    assert.equal(
      result.signatureIssues.some(
        (issue) =>
          issue.kind === "mailbox_sig" &&
          issue.detail.includes("clean@salesglidertop.org"),
      ),
      false,
      "empty Insight mailbox signature is compliant",
    );
    assert.ok(
      result.signatureIssues.some(
        (issue) =>
          issue.campaignId === 3921647 &&
          issue.kind === "insight_shared_staff" &&
          issue.detail.includes("shared@salesglidertop.org") &&
          issue.detail.includes("#89"),
      ),
      "QA must flag Insight staff that also sit on ACTIVE SalesGlider",
    );
  });
});
