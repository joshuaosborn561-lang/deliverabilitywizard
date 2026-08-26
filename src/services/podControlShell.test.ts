import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { defaultControlTemplate } from "../lib/controlTemplate.js";
import { POD_CONTROL_SHELL_NAME } from "../lib/podControlShell.js";
import { StateStore } from "../state/store.js";
import { ensurePodControlShell } from "./podControlShell.js";

describe("ensurePodControlShell", () => {
  it("uses the paused shell and refuses a live campaign as fallback", async () => {
    const state = new StateStore(
      `/tmp/dw-shell-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const added: number[][] = [];
    const statuses: string[] = [];
    const result = await ensurePodControlShell({
      config,
      smartlead: {
        listCampaigns: async () => [
          { id: 1, name: "Acme", status: "ACTIVE", client_id: 9 },
          { id: 99, name: POD_CONTROL_SHELL_NAME, status: "PAUSED" },
        ],
        getCampaignSequences: async () => [
          { id: 77, seq_number: 1, subject: "Quick check-in", email_body: "<div>Hi</div>" },
        ],
        updateCampaignSequences: async () => undefined,
        getCampaignEmailAccounts: async () => [],
        addEmailAccountsToCampaign: async (_id: number, ids: number[]) => {
          added.push(ids);
        },
        removeEmailAccountsFromCampaign: async () => undefined,
        updateCampaignStatus: async (_id: number, status: string) => {
          statuses.push(status);
        },
        createCampaign: async () => {
          throw new Error("should reuse the existing shell");
        },
      } as never,
      state,
      pods: [
        {
          id: "generic:resting",
          name: "Generic sitting",
          pool: "generic_resting",
          status: "resting",
          clientId: null,
          mailboxes: [{ accountId: 11, email: "sit@cleartechco.com", clientId: null, clientName: "Generic" }],
        },
        {
          id: "client:9:B",
          name: "Acme B",
          pool: "B",
          status: "active",
          clientId: 9,
          mailboxes: [{ accountId: 12, email: "send@acme.com", clientId: 9, clientName: "Acme" }],
        },
      ],
      template: defaultControlTemplate(),
      dryRun: false,
    });

    assert.equal(result.campaignId, 99);
    assert.equal(result.sequenceMappingId, 77);
    assert.equal(result.paused, true);
    assert.deepEqual(added.flat().sort((a, b) => a - b), [11, 12]);
    assert.equal(statuses.includes("START"), false);
    assert.equal(state.getIsolation().shellCampaignId, 99);
  });

  it("does not hang on the first ACTIVE campaign when the shell is missing", async () => {
    const state = new StateStore(
      `/tmp/dw-shell-miss-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    await assert.rejects(
      () =>
        ensurePodControlShell({
          config,
          smartlead: {
            listCampaigns: async () => [
              { id: 1, name: "Acme", status: "ACTIVE" },
            ],
          } as never,
          state,
          pods: [],
          template: defaultControlTemplate(),
          dryRun: true,
        }),
      /missing/,
    );
  });
});
