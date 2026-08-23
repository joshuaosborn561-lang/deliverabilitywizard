import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { CopyIsolationService } from "./copyIsolation.js";
import { IsolationRigService } from "./isolationRig.js";

describe("copy isolation", () => {
  it("does not write production campaigns and starts without seed approval", async () => {
    const writes: string[] = [];
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
      getCampaignSequences: async () => [
        {
          id: 1,
          seq_number: 1,
          subject: "Free consult this week",
          email_body: "We have a free consult. https://book.example.test/x",
        },
      ],
      listAllEmailAccounts: async () => [
        { id: 9, from_email: "lab@iso.test" },
      ],
      isolationDenylistIds: () => [9],
      setIsolationDenylist: () => undefined,
    };
    const created: unknown[] = [];
    const smartDelivery = {
      createManualPlacement: async (payload: unknown) => {
        created.push(payload);
        return { id: `t${created.length}` };
      },
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
    assert.equal(
      (created[0] as { sequence?: { steps?: Array<{ email_body?: string }> } })
        .sequence?.steps?.[0]?.email_body?.includes("free") === false ||
        created.some((row) =>
          JSON.stringify(row).toLowerCase().includes("complimentary"),
        ),
      true,
    );
  });
});
