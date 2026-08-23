import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { PodControlService } from "./podControls.js";

describe("pod controls", () => {
  it("schedules the full pod without a seed-approval stop", async () => {
    const state = new StateStore(
      `/tmp/dw-pod-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const created: Array<{ sender_accounts?: string[] }> = [];
    const service = new PodControlService(
      config,
      {
        listCampaigns: async () => [
          { id: 1, name: "Acme", status: "ACTIVE", client_id: 9 },
        ],
        listClients: async () => [{ id: 9, name: "Acme" }],
        listAllEmailAccounts: async () => [
          {
            id: 1,
            from_email: "a@client.com",
            client_id: 9,
            campaign_ids: [1],
          },
          {
            id: 2,
            from_email: "b@client.com",
            client_id: 9,
            campaign_ids: [1],
          },
        ],
        getCampaignSequences: async () => [
          { id: 77, seq_number: 1, subject: "Quick check-in" },
        ],
      } as never,
      {
        listFolders: async () => [],
        createFolder: async () => ({ id: 3 }),
        listTests: async () => [],
        createAutomatedPlacement: async (payload: {
          sender_accounts?: string[];
          sequence_mapping_id?: number;
        }) => {
          created.push(payload);
          return { id: `pod-${created.length}` };
        },
        getSenderAccountReport: async () => [],
      } as never,
      { notifyPodControls: async () => undefined } as never,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.ok(result.testsCreated.length >= 1);
    const attached = created.flatMap((row) => row.sender_accounts ?? []);
    assert.ok(attached.includes("a@client.com"));
    assert.ok(attached.includes("b@client.com"));
    assert.equal(
      created.some((row) =>
        JSON.stringify(row).includes("Quick check-in"),
      ),
      true,
    );
    assert.equal(
      created.every((row) => row.sequence_mapping_id === 77),
      true,
      "SmartDelivery schedule requires sequence_mapping_id from the shell campaign",
    );
  });
});
