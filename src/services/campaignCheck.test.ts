import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import { firstCheckPassed } from "../lib/campaignCheck.js";
import { StateStore } from "../state/store.js";
import { CampaignCheckService } from "./campaignCheck.js";

function stateFile(): string {
  return `/tmp/campaign-check-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

const goliath = { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" };
const peterson = { id: 548610, name: "Peterson", logo: "Roofs by Peterson" };

function delivery(): SmartDeliveryClient {
  return {
    listTests: async () => [],
    enrichCampaignIds: async (rows: unknown[]) => rows,
  } as unknown as SmartDeliveryClient;
}

describe("campaign check first-pass helpers", () => {
  it("D80: staffing findings do not block the first check", () => {
    assert.equal(
      firstCheckPassed([
        { kind: "understaffed", detail: "short 10" },
        { kind: "no_placement_test", detail: "no test" },
      ]),
      true,
    );
    assert.equal(
      firstCheckPassed([{ kind: "mailbox_sig", detail: "peterson" }]),
      false,
    );
  });
});

describe("CampaignCheckService", () => {
  it("D80: a new campaign with a foreign signature fails the first check", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const service = new CampaignCheckService(
      loadConfig({}),
      {
        listCampaigns: async () => [
          {
            id: 3826693,
            name: "Goliath Education Receipts - Large Public",
            status: "ACTIVE",
            client_id: 548611,
          },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "zuri@pool.info",
            from_name: "Zuri Hernandez",
            signature: "Zuri Hernandez\nRoofs by Peterson",
            client_id: 548611,
            campaign_ids: [3826693],
            is_smtp_success: true,
            is_imap_success: true,
          },
        ],
        listClients: async () => [goliath, peterson],
        getCampaignSettings: async () => ({ bounce_autopause_threshold: 20 }),
        getCampaignSequences: async () => [
          {
            seq_number: 1,
            email_body: "<div>Hi</div><div>%signature%</div>",
          },
        ],
      } as unknown as SmartleadClient,
      delivery(),
      state,
    );

    const result = await service.run({ mode: "first" });
    assert.equal(result.firstSeen, 1);
    assert.equal(result.firstPassed, 0);
    assert.ok(
      result.findings[0]?.findings.some((finding) => finding.kind === "mailbox_sig"),
      "first check must catch Peterson on Goliath",
    );
    assert.equal(state.getCampaignCheck(3826693)?.firstPassedAt, null);
  });

  it("D80: a clean campaign passes first check; hourly skips sequences and settings", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    let settingsReads = 0;
    let sequenceReads = 0;
    const sl = {
      listCampaigns: async () => [
        {
          id: 3815448,
          name: "Goliath Displacement L 501-1000 ITDir",
          status: "ACTIVE",
          client_id: 548611,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 22,
          from_email: "aarav@pool.info",
          from_name: "Aarav Sanchez",
          signature: "Aarav Sanchez\nGoliath Cybersecurity",
          client_id: 548611,
          campaign_ids: [3815448],
          is_smtp_success: true,
          is_imap_success: true,
        },
      ],
      listClients: async () => [goliath, peterson],
      getCampaignSettings: async () => {
        settingsReads += 1;
        return { bounce_autopause_threshold: 20 };
      },
      getCampaignSequences: async () => {
        sequenceReads += 1;
        return [
          {
            seq_number: 1,
            email_body: "<div>The screenshots are the part IT teams thank us for.</div><div>%signature%</div>",
          },
        ];
      },
    } as unknown as SmartleadClient;
    const service = new CampaignCheckService(loadConfig({}), sl, delivery(), state);

    const first = await service.run({ mode: "first" });
    assert.equal(first.firstPassed, 1);
    assert.ok(state.getCampaignCheck(3815448)?.firstPassedAt);
    assert.equal(settingsReads, 1);
    assert.equal(sequenceReads, 1);

    const hourly = await service.run({ mode: "hourly" });
    assert.equal(hourly.swept, 1);
    assert.equal(settingsReads, 1, "hourly must not re-read campaign settings");
    assert.equal(sequenceReads, 1, "hourly must not re-read sequences");
  });

  it("D80: the pod control shell must stay paused; a paused shell passes", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const make = async (status: string) => {
      const store = new StateStore(stateFile());
      await store.load();
      return new CampaignCheckService(
        loadConfig({}),
        {
          listCampaigns: async () => [
            { id: 3841904, name: "Pod control shell", status, client_id: null },
          ],
          listAllEmailAccounts: async () => [],
          listClients: async () => [goliath],
          getCampaignSettings: async () => {
            throw new Error("shell should not read settings");
          },
          getCampaignSequences: async () => {
            throw new Error("shell should not read sequences");
          },
        } as unknown as SmartleadClient,
        delivery(),
        store,
      ).run({ mode: "first" });
    };

    const paused = await make("PAUSED");
    assert.equal(paused.firstPassed, 1);
    const live = await make("ACTIVE");
    assert.equal(live.firstPassed, 0);
    assert.ok(
      live.findings[0]?.findings.some((finding) => finding.kind === "shell_not_paused"),
    );
  });
});
