import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { CopyIsolationService } from "./copyIsolation.js";
import { IsolationRigService } from "./isolationRig.js";

describe("copy isolation", () => {
  it("does not write production campaigns and starts without seed approval", async () => {
    const writes: string[] = [];
    const writtenSeqs: number[] = [];
    let shellSequences: Array<{
      id: number;
      seq_number: number;
      subject: string;
      email_body: string;
    }> = [
      {
        id: 77,
        seq_number: 1,
        subject: "Free consult this week",
        email_body: "We have a free consult. https://book.example.test/x",
      },
    ];
    const state = new StateStore(
      `/tmp/dw-copy-iso-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const smartlead = {
      addEmailAccountsToCampaign: async () => {
        writes.push("add");
      },
      removeEmailAccountsFromCampaign: async () => {
        writes.push("remove");
      },
      updateCampaignStatus: async () => {
        writes.push("status");
      },
      createCampaign: async () => ({ id: 99, name: "DW Word Hunt Shell" }),
      listCampaigns: async () => [
        { id: 99, name: "DW Word Hunt Shell", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        { id: 9, from_email: "lab@iso.test", campaign_ids: [99] },
      ],
      getCampaignLeads: async () => ({ data: [{ id: 1 }] }),
      addLeadsToCampaign: async () => ({ added_count: 1 }),
      getCampaignSequences: async () => shellSequences,
      updateCampaignSequences: async (
        _id: number,
        sequences: Array<{
          seq_number?: number;
          subject?: string;
          email_body?: string;
        }>,
      ) => {
        writtenSeqs.push(...sequences.map((row) => row.seq_number ?? 0));
        shellSequences = sequences.map((row, index) => ({
          id: 100 + index,
          seq_number: row.seq_number ?? index + 1,
          subject: row.subject ?? `v${index}`,
          email_body: row.email_body ?? "",
        }));
      },
      isolationDenylistIds: () => [9],
      setIsolationDenylist: () => undefined,
    };
    const created: unknown[] = [];
    const smartDelivery = {
      createManualPlacement: async (payload: unknown) => {
        created.push(payload);
        return { id: `t${created.length}` };
      },
      resolveProviderIds: async () => [2, 20, 21],
      getSpamFilterDetails: async () => [],
      getEmailContent: async () => ({}),
      getProviderwiseReport: async () => ({ result: [] }),
    };
    const slack = {
      notifyCopyIsolation: async () => undefined,
      notifyIsolationVerdict: async () => undefined,
      notifyIsolationAction: async () => undefined,
    };
    const rig = new IsolationRigService(
      { ...config, isolationDomain: "iso.test", isolationMailboxEmails: ["lab@iso.test"] },
      smartlead as never,
      smartDelivery as never,
      slack as never,
      state,
    );
    const service = new CopyIsolationService(
      { ...config, isolationDomain: "iso.test", isolationMailboxEmails: ["lab@iso.test"] },
      smartlead as never,
      smartDelivery as never,
      slack as never,
      state,
      rig,
    );

    const result = await service.runForCampaign({
      id: "run-1",
      campaignId: 42,
      campaignName: "Acme",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      control: "CLEAN",
      verdict: "COPY",
      campaignInSpam: true,
      reason: "copy",
    });

    assert.equal(writes.length, 0);
    assert.equal(result.started, true);
    assert.ok(created.length >= 1);
    assert.ok(writtenSeqs.length >= 1, "shell got a multi-seq write");
    const first = created[0] as {
      campaign_id?: number;
      sequence_mapping_id?: number;
      provider_ids?: number[];
    };
    assert.equal(first.campaign_id, 99, "D151: word hunt rides the shell");
    assert.ok(
      typeof first.sequence_mapping_id === "number" &&
        first.sequence_mapping_id >= 100,
      `mapping id present: ${first.sequence_mapping_id}`,
    );
    assert.deepEqual(first.provider_ids, [2, 20, 21]);
  });
});
