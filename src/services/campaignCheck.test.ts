import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import { firstCheckPassed } from "../lib/campaignCheck.js";
import { campaignMayTakeGenerics } from "../lib/genericBackfill.js";
import { isPocClient } from "../lib/pocClient.js";
import { StateStore } from "../state/store.js";
import { CampaignCheckService } from "./campaignCheck.js";

function stateFile(): string {
  return `/tmp/campaign-check-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

const goliath = { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" };
const peterson = { id: 548610, name: "Peterson", logo: "Roofs by Peterson" };

function delivery(tests: unknown[] = []): SmartDeliveryClient {
  return {
    listTests: async () => tests,
    enrichCampaignIds: async (rows: unknown[]) => rows,
  } as unknown as SmartDeliveryClient;
}

describe("campaign check first-pass helpers", () => {
  it("D81: staffing and canary findings do not block the first check", () => {
    assert.equal(
      firstCheckPassed([
        { kind: "understaffed", detail: "short 10" },
        { kind: "missing_canary", detail: "no canary" },
        { kind: "no_placement_test", detail: "no test" },
        { kind: "inbox_missing_known_good", detail: "inbox" },
      ]),
      true,
    );
    assert.equal(
      firstCheckPassed([{ kind: "mailbox_sig", detail: "peterson" }]),
      false,
    );
    assert.equal(
      firstCheckPassed([{ kind: "generic_unapproved", detail: "generic" }]),
      false,
    );
  });

  it("D81: Goliath is a POC client; generics elsewhere need Slack approve", () => {
    assert.equal(isPocClient("Goliath Displacement", ["goliath"]), true);
    assert.equal(
      campaignMayTakeGenerics(
        { id: 1, name: "Goliath Displacement" },
        "Goliath",
        ["goliath"],
        {},
      ),
      true,
    );
    assert.equal(
      campaignMayTakeGenerics(
        { id: 2, name: "Vasco - Service" },
        "Vasco Warranty",
        ["goliath"],
        {},
      ),
      false,
    );
    assert.equal(
      campaignMayTakeGenerics(
        { id: 2, name: "Vasco - Service" },
        "Vasco Warranty",
        ["goliath"],
        { "2": { campaignId: 2, approvedAt: "2026-08-25T00:00:00Z", approvedBy: "josh" } },
      ),
      true,
    );
  });
});

describe("CampaignCheckService", () => {
  it("D81: a new campaign with a foreign signature fails the first check", async () => {
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
    assert.equal(
      result.findings[0]?.findings.some((finding) => finding.kind === "bounce_autopause"),
      false,
      "bounce auto-pause is not this checker",
    );
    assert.equal(state.getCampaignCheck(3826693)?.firstPassedAt, null);
  });

  it("D81: a clean campaign passes first check; hourly skips sequences", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    let sequenceReads = 0;
    let settingsReads = 0;
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
          from_email: "aarav@client.com",
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
    const service = new CampaignCheckService(
      loadConfig({}),
      sl,
      delivery([
        {
          id: "t-canary",
          test_name: "Canary copy: #3815448 Goliath Displacement L",
          status: "active",
          every_days: 1,
          campaign_id: 3815448,
        },
        {
          id: "t-place",
          test_name: "Goliath Displacement L",
          status: "active",
          every_days: 1,
          campaign_id: 3815448,
        },
      ]),
      state,
    );

    const first = await service.run({ mode: "first" });
    assert.equal(first.firstPassed, 1);
    assert.ok(state.getCampaignCheck(3815448)?.firstPassedAt);
    assert.equal(sequenceReads, 1);
    assert.equal(settingsReads, 0, "first check must not read bounce auto-pause");

    const hourly = await service.run({ mode: "hourly" });
    assert.equal(hourly.swept, 1);
    assert.equal(sequenceReads, 1, "hourly must not re-read sequences");
    assert.ok(
      hourly.findings[0]?.findings.some(
        (finding) => finding.kind === "inbox_missing_known_good",
      ),
      "hourly must flag a serving inbox that is not on a known-good canary",
    );
  });

  it("D82: hourly passes when the serving inbox is on a known-good canary and copy is on the unwarmed fleet", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    state.upsertPodControl({
      id: "client:548611:B:0",
      podId: "client:548611:B",
      controlVersion: "v1",
      spamTestId: "pc-1",
      emails: ["aarav@client.com"],
      createdAt: "2026-08-25T00:00:00.000Z",
    });
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
          from_email: "aarav@client.com",
          from_name: "Aarav Sanchez",
          signature: "Aarav Sanchez\nGoliath Cybersecurity",
          client_id: 548611,
          campaign_ids: [3815448],
          is_smtp_success: true,
          is_imap_success: true,
        },
      ],
      listClients: async () => [goliath, peterson],
      getCampaignSequences: async () => [
        {
          seq_number: 1,
          email_body: "<div>Hi</div><div>%signature%</div>",
        },
      ],
    } as unknown as SmartleadClient;
    const service = new CampaignCheckService(
      loadConfig({}),
      sl,
      delivery([
        {
          id: "t-canary",
          test_name: "Canary copy: #3815448 Goliath Displacement L",
          status: "active",
          every_days: 1,
          campaign_id: 3815448,
        },
        {
          id: "t-place",
          test_name: "Goliath Displacement L",
          status: "active",
          every_days: 1,
          campaign_id: 3815448,
        },
        {
          id: "pc-1",
          test_name: "Pod control: client:548611:B",
          status: "active",
          every_days: 1,
        },
      ]),
      state,
    );

    const first = await service.run({ mode: "first" });
    assert.equal(first.firstPassed, 1);
    const hourly = await service.run({ mode: "hourly" });
    assert.equal(
      hourly.findings[0]?.findings.some(
        (finding) =>
          finding.kind === "inbox_missing_known_good" ||
          finding.kind === "missing_canary",
      ),
      false,
    );
  });

  it("D84: COMPLETED/STOPPED campaigns leave the sweep and their findings are archived", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    state.upsertCampaignCheck({
      campaignId: 3739316,
      name: "Cold Call Followup",
      firstSeenAt: "2026-08-20T00:00:00.000Z",
      firstCheckAt: "2026-08-20T00:00:00.000Z",
      firstPassedAt: null,
      lastSweepAt: null,
      lastKind: "first",
      findings: ["missing_signature_tag: step 1 A is missing %signature%"],
    });
    const service = new CampaignCheckService(
      loadConfig({}),
      {
        listCampaigns: async () => [
          { id: 3739316, name: "Cold Call Followup", status: "COMPLETED", client_id: 345263 },
        ],
        listAllEmailAccounts: async () => [],
        listClients: async () => [goliath],
        getCampaignSequences: async () => {
          throw new Error("terminal campaigns must not be inspected");
        },
      } as unknown as SmartleadClient,
      delivery(),
      state,
    );

    await service.run({ mode: "all" });
    assert.equal(
      state.getCampaignCheck(3739316),
      undefined,
      "terminal campaigns must not keep stale findings on the scoreboard",
    );
  });

  it("D85: a dead canary fleet is one fact, not a finding per campaign", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    // Fleet is known but none of its mailboxes are connected in Smartlead.
    state.setCopyCanaryFleet({
      status: "ready",
      domains: ["getcrosslaunchco.info"],
      emails: ["canary@getcrosslaunchco.info"],
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    const sl = {
      listCampaigns: async () => [
        { id: 1, name: "Goliath A", status: "ACTIVE", client_id: 548611 },
        { id: 2, name: "Goliath B", status: "ACTIVE", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [],
      listClients: async () => [goliath],
      getCampaignSequences: async () => [
        { seq_number: 1, email_body: "<div>Hi</div><div>%signature%</div>" },
      ],
    } as unknown as SmartleadClient;
    const service = new CampaignCheckService(loadConfig({}), sl, delivery(), state);

    await service.run({ mode: "first" });
    const hourly = await service.run({ mode: "hourly" });
    for (const row of hourly.findings) {
      assert.equal(
        row.findings.some(
          (finding) =>
            finding.kind === "missing_canary" || finding.kind === "canary_inactive",
        ),
        false,
        "fleet-down must not spam per-campaign canary findings",
      );
    }
    assert.ok(
      state.getCanaryFleetDown(),
      "fleet-down must be recorded once as a fleet-level fact",
    );
  });

  it("D85: per-campaign canary checks resume the moment the fleet is connected", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    state.setCanaryFleetDown({ since: "2026-08-20T00:00:00.000Z", fleetSize: 1 });
    state.setCopyCanaryFleet({
      status: "ready",
      domains: ["getcrosslaunchco.info"],
      emails: ["canary@getcrosslaunchco.info"],
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    const sl = {
      listCampaigns: async () => [
        { id: 1, name: "Goliath A", status: "ACTIVE", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 9,
          from_email: "canary@getcrosslaunchco.info",
          from_name: "Canary",
          campaign_ids: [],
          is_smtp_success: true,
          is_imap_success: true,
        },
      ],
      listClients: async () => [goliath],
      getCampaignSequences: async () => [
        { seq_number: 1, email_body: "<div>Hi</div><div>%signature%</div>" },
      ],
    } as unknown as SmartleadClient;
    const service = new CampaignCheckService(loadConfig({}), sl, delivery(), state);

    await service.run({ mode: "first" });
    const hourly = await service.run({ mode: "hourly" });
    assert.equal(state.getCanaryFleetDown(), null, "fleet-down fact must clear");
    assert.ok(
      hourly.findings[0]?.findings.some(
        (finding) => finding.kind === "missing_canary",
      ),
      "a campaign without a canary test is a finding again once the fleet is up",
    );
  });

  it("D85: missing %signature% posts a one-tap fix ask", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const asked: Array<{ kind: string; actionId: string }> = [];
    const slack = {
      notifyIsolationAction: async (details: { kind: string; actionId: string }) => {
        asked.push({ kind: details.kind, actionId: details.actionId });
      },
    } as never;
    const service = new CampaignCheckService(
      loadConfig({}),
      {
        listCampaigns: async () => [
          { id: 77, name: "SalesGlider Nurture", status: "ACTIVE", client_id: 548611 },
        ],
        listAllEmailAccounts: async () => [],
        listClients: async () => [goliath],
        getCampaignSequences: async () => [
          { seq_number: 1, email_body: "<div>Sean, that offer's still open</div>" },
        ],
      } as unknown as SmartleadClient,
      delivery(),
      state,
      slack,
    );

    const result = await service.run({ mode: "first" });
    assert.equal(result.firstPassed, 0, "missing tag still blocks first-check");
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.kind, "add_signature_tag");
    const action = state
      .listIsolationActions()
      .find((row) => row.kind === "add_signature_tag");
    assert.ok(action);
    assert.equal(Number(action?.detail.campaignId), 77);
  });

  it("D87: several blocked campaigns get ONE bulk %signature% ask, not one each", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const asked: Array<{ kind: string }> = [];
    const slack = {
      notifyIsolationAction: async (details: { kind: string }) => {
        asked.push({ kind: details.kind });
      },
    } as never;
    const service = new CampaignCheckService(
      loadConfig({}),
      {
        listCampaigns: async () => [
          { id: 81, name: "SalesGlider Nurture", status: "ACTIVE", client_id: 548611 },
          { id: 82, name: "Parlay2 Sports Offer", status: "ACTIVE", client_id: 548611 },
          { id: 83, name: "Positive", status: "ACTIVE", client_id: 548611 },
        ],
        listAllEmailAccounts: async () => [],
        listClients: async () => [goliath],
        getCampaignSequences: async () => [
          { seq_number: 1, email_body: "<div>Sean, that offer's still open</div>" },
        ],
      } as unknown as SmartleadClient,
      delivery(),
      state,
      slack,
    );

    await service.run({ mode: "all" });
    assert.equal(asked.length, 1, "three blocked campaigns must be one bulk ask");
    const action = state
      .listIsolationActions()
      .find((row) => row.kind === "add_signature_tag");
    assert.ok(action);
    assert.deepEqual(
      [...((action?.detail.campaignIds as number[]) ?? [])].sort(),
      [81, 82, 83],
    );

    // A second sweep re-finds the same campaigns — covered, no new ask.
    await service.run({ mode: "all" });
    assert.equal(asked.length, 1, "covered campaigns must not re-ask");
    assert.equal(
      state
        .listIsolationActions()
        .filter((row) => row.kind === "add_signature_tag").length,
      1,
    );
  });

  it("D81: the pod control shell must stay paused; a paused shell passes", async () => {
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
