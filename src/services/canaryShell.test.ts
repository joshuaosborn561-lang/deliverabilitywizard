import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { ensureCanaryShell } from "./canaryShell.js";

describe("ensureCanaryShell", () => {
  it("reuses a paused shell, writes live copy, and adds only canary accounts", async () => {
    const added: Array<{ campaignId: number; ids: number[] }> = [];
    const written: Array<{ campaignId: number; subject?: string }> = [];
    const seeded: Array<{ campaignId: number; email: string }> = [];
    const campaigns: SmartleadCampaign[] = [
      { id: 4, name: "Live A", status: "ACTIVE", client_id: 2 },
      { id: 104, name: "Canary shell: #4 Live A", status: "PAUSED" },
    ];
    const result = await ensureCanaryShell({
      smartlead: {
        createCampaign: async () => {
          throw new Error("should reuse the existing shell");
        },
        updateCampaignStatus: async () => {
          throw new Error("already paused");
        },
        getCampaignSequences: async () => [
          { id: 77, seq_number: 1, subject: "Old", email_body: "<div>Old</div>" },
        ],
        updateCampaignSequences: async (campaignId: number, sequences: Array<{ subject?: string }>) => {
          written.push({ campaignId, subject: sequences[0]?.subject });
        },
        addLeadsToCampaign: async (
          campaignId: number,
          leads: Array<{ email: string }>,
        ) => {
          seeded.push({ campaignId, email: leads[0]!.email });
        },
        getCampaignEmailAccounts: async () => [],
        addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
          added.push({ campaignId, ids });
        },
      } as unknown as SmartleadClient,
      campaigns,
      live: campaigns[0]!,
      subject: "Quick look",
      bodyHtml: "<div>Campaign copy</div>",
      senderAccountIds: [11, 12],
      dryRun: false,
    });

    assert.equal(result.campaignId, 104);
    assert.equal(result.sequenceMappingId, 77);
    assert.equal(result.created, false);
    assert.deepEqual(written, [{ campaignId: 104, subject: "Quick look" }]);
    assert.deepEqual(seeded, [
      { campaignId: 104, email: "canary.shell.seed@getcrosslaunchco.info" },
    ]);
    assert.deepEqual(added, [{ campaignId: 104, ids: [11, 12] }]);
  });

  it("refuses an ACTIVE shell", async () => {
    await assert.rejects(
      () =>
        ensureCanaryShell({
          smartlead: {} as SmartleadClient,
          campaigns: [
            { id: 4, name: "Live A", status: "ACTIVE" },
            { id: 104, name: "Canary shell: #4 Live A", status: "ACTIVE" },
          ],
          live: { id: 4, name: "Live A", status: "ACTIVE" },
          subject: "Hi",
          bodyHtml: "Body",
          senderAccountIds: [11],
          dryRun: false,
        }),
      /ACTIVE/,
    );
  });
});
