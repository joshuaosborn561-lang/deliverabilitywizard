import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { IsolationBranchService } from "./isolationBranch.js";

const AIRPODS = {
  id: 3847794,
  name: "TechEvo SFL Startup Owners AirPods",
  status: "ACTIVE",
};

const SALESGLIDER = {
  id: 3748412,
  name: "SalesGlider Trades Airpods",
  status: "PAUSED",
};

function providerReport(inbox: number) {
  return {
    result: [
      { provider_name: "Gmail", inbox_rate: inbox, inbox_count: inbox === 0 ? 0 : 8, spam_count: inbox === 0 ? 8 : 0 },
      { provider_name: "Outlook", inbox_rate: inbox, inbox_count: inbox === 0 ? 0 : 8, spam_count: inbox === 0 ? 8 : 0 },
    ],
  };
}

async function buildBranch(opts: {
  knownGoodInbox: number;
  canaryInbox: number;
  mailboxPlacement?: "PRIMARY" | "SPAM" | "UNKNOWN";
  rigEmails?: string[];
  campaign?: { id: number; name: string; status: string };
  canaryTestId?: string | null;
}) {
  const campaign = opts.campaign ?? AIRPODS;
  const state = new StateStore(
    `/tmp/dw-iso-branch-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await state.load();
  state.upsertMailboxControl({
    email: "a@techevo.test",
    ranAt: "2026-09-01T18:00:00.000Z",
    placement: opts.mailboxPlacement ?? "PRIMARY",
    history: [opts.mailboxPlacement ?? "PRIMARY"],
    rollingFailCount: 0,
    tag: "ok",
  });
  state.upsertPodControl({
    id: "pod-1",
    podId: "pod-1",
    controlVersion: "v1",
    spamTestId: "known-good-1",
    emails: ["a@techevo.test"],
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  if (opts.canaryTestId === null) {
    state.setCopyCanaries(campaign.id, ["canary@g.test"]);
  } else {
    state.setCopyCanaries(
      campaign.id,
      ["canary@g.test"],
      opts.canaryTestId ?? `canary-${campaign.id}`,
    );
  }

  const evaluated: number[] = [];
  const teardowns: number[] = [];
  const config = loadConfig({} as NodeJS.ProcessEnv);

  const healed: number[] = [];
  const smartlead = {
    listCampaigns: async () => [campaign],
    getCampaign: async (id: number) =>
      id === campaign.id
        ? campaign
        : { id, name: `Campaign ${id}`, status: "ACTIVE" },
    getCampaignEmailAccounts: async () => [
      { id: 1, from_email: "a@techevo.test" },
    ],
  };
  const smartDelivery = {
    listTests: async () => [
      {
        id: opts.canaryTestId === null ? undefined : `canary-${campaign.id}`,
        test_name: `Canary copy: #${campaign.id} ${campaign.name}`,
        campaign_id: 999001,
      },
    ],
    getProviderwiseReport: async (testId: string) =>
      testId === "known-good-1"
        ? providerReport(opts.knownGoodInbox)
        : providerReport(opts.canaryInbox),
    getIpBlacklist: async () => [],
    getDomainBlacklist: async () => [],
    getDkimDetails: async () => null,
    getSpfDetails: async () => null,
    getRdnsDetails: async () => null,
    getIpAnalytics: async () => null,
  };
  const isolationPages: string[] = [];
  const placementPages: number[] = [];
  const slack = {
    notifyIsolationVerdict: async (details: { verdict: string }) => {
      isolationPages.push(details.verdict);
    },
    notifyPlacementResult: async () => {
      placementPages.push(1);
    },
  };
  const copyIsolation = {
    runForCampaign: async (run: { campaignId: number }) => {
      teardowns.push(run.campaignId);
      const emails = opts.rigEmails ?? ["iso@techevo.test"];
      if (!emails.length) return { started: false, waiting: true };
      return { started: true, waiting: false };
    },
  };
  const armed: number[] = [];
  const rig = {
    readLatestControl: async () => null,
    rigEmails: async () => opts.rigEmails ?? ["iso@techevo.test"],
    ensureArmed: async () => {
      armed.push(1);
    },
  };
  const copyCanary = {
    readSplit: async () => ({
      // Campaign-copy on warmed peers also buried — not the known-good control.
      unwarmedLanded: opts.canaryInbox < 80 ? false : true,
      warmedLanded: opts.canaryInbox < 80 ? false : true,
      unwarmedTested: 3,
      warmedTested: 3,
      unwarmedInbox: opts.canaryInbox < 80 ? 0 : 3,
      warmedInbox: opts.canaryInbox < 80 ? 0 : 3,
    }),
    describeSplit: () => undefined,
    healMissingTestId: async (campaignId: number) => {
      healed.push(campaignId);
      const id = `healed-${campaignId}`;
      state.setCopyCanaries(campaignId, ["canary@g.test"], id);
      return id;
    },
  };

  const branch = new IsolationBranchService(
    { ...config, enableIsolationBranch: true, enableCopyIsolation: true, dryRun: false },
    smartlead as never,
    smartDelivery as never,
    slack as never,
    state,
    copyIsolation as never,
    rig as never,
    copyCanary as never,
  );
  const originalEvaluate = branch.evaluate.bind(branch);
  branch.evaluate = async (campaignId, evaluateOpts) => {
    evaluated.push(campaignId);
    return originalEvaluate(campaignId, evaluateOpts);
  };
  return {
    branch,
    state,
    evaluated,
    teardowns,
    armed,
    isolationPages,
    placementPages,
    healed,
    campaign,
  };
}

describe("IsolationBranchService placement queue (D158)", () => {
  it("canary-copy under 80% marks a suspect and evaluates the live campaign", async () => {
    const { branch, state, evaluated, teardowns, isolationPages, placementPages } =
      await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
    });

    const result = await branch.run();

    const suspect = state.listCopySuspects().find((row) => row.campaignId === AIRPODS.id);
    assert.ok(suspect, "canary 0% must mark the live campaign as a copy suspect");
    assert.match(String(suspect.reason), /Canary-copy same-ESP/);
    assert.deepEqual(evaluated, [AIRPODS.id]);
    assert.equal(result.copy, 1);
    assert.deepEqual(teardowns, [AIRPODS.id], "COPY starts the word hunt");
    assert.ok(suspect.evaluatedAt, "terminal COPY stamps evaluatedAt");
    const score = state.listPlacementScores().find((row) => row.campaignId === AIRPODS.id);
    assert.ok(score, "15-minute on-ramp persists the same-ESP reading");
    assert.equal(score.source, "canary-copy");
    assert.equal(score.inboxPercent, 0);
    assert.ok(placementPages.length >= 1, "first under-bar reading pages Slack");
    assert.ok(isolationPages.includes("COPY"), "COPY isolation pages Slack (D163)");
  });

  it("does not re-hunt on the next tick after a terminal verdict", async () => {
    const { branch, evaluated } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
    });
    await branch.run();
    evaluated.length = 0;
    const second = await branch.run();
    assert.deepEqual(evaluated, []);
    assert.equal(second.evaluated, 0);
  });

  it("re-queues after COPY when the latest run is INCONCLUSIVE (D164)", async () => {
    const { branch, state, evaluated } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
    });
    await branch.run();
    const afterCopy = state
      .listCopySuspects()
      .find((row) => row.campaignId === AIRPODS.id);
    assert.ok(afterCopy?.evaluatedAt, "COPY stamps evaluatedAt");

    state.upsertIsolationRun({
      id: "later-inconclusive",
      campaignId: AIRPODS.id,
      campaignName: AIRPODS.name,
      startedAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason: "need another reading",
    });

    evaluated.length = 0;
    const second = await branch.run();
    assert.deepEqual(evaluated, [AIRPODS.id], "Goliath Education hole: must re-evaluate");
    assert.ok(second.evaluated >= 1);
    const after = state
      .listCopySuspects()
      .find((row) => row.campaignId === AIRPODS.id);
    assert.ok(
      after && (after.evaluatedAt === undefined || after.evaluatedAt),
      "re-queue cleared the sticky evaluatedAt long enough to evaluate",
    );
  });

  it("COPY with an unarmed rig waits and asks to arm once", async () => {
    const { branch, armed, teardowns } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
      rigEmails: [],
    });
    const run = await branch.evaluate(AIRPODS.id, { campaignInSpam: true });
    assert.equal(run.verdict, "COPY");
    assert.equal(run.teardownStarted, true, "waiting on the rig still marks teardown started");
    assert.deepEqual(teardowns, [AIRPODS.id]);
    assert.equal(armed.length, 1, "unarmed COPY asks to arm the rig once");
  });

  it("dominant content_block queues the live campaign and evaluates", async () => {
    const { branch, state, evaluated, teardowns } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
      mailboxPlacement: "UNKNOWN",
    });
    await branch.queueContentBlockSuspect(AIRPODS.id);
    const suspect = state.listCopySuspects().find((row) => row.campaignId === AIRPODS.id);
    assert.ok(suspect);
    assert.match(String(suspect.reason), /content_block/);
    assert.deepEqual(evaluated, [AIRPODS.id]);
    assert.deepEqual(teardowns, [AIRPODS.id]);
    const run = state.latestIsolationRunForCampaign(AIRPODS.id);
    assert.equal(run?.verdict, "COPY");
  });

  it("content_block queue is idempotent after a terminal COPY", async () => {
    const { branch, evaluated } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
    });
    await branch.queueContentBlockSuspect(AIRPODS.id);
    evaluated.length = 0;
    await branch.queueContentBlockSuspect(AIRPODS.id);
    assert.deepEqual(evaluated, []);
  });

  it("does not re-evaluate or page INCONCLUSIVE on a COMPLETED campaign (D165)", async () => {
    const completed = {
      id: 3763805,
      name: "BCP Logistics Over-1k (With Team)",
      status: "COMPLETED",
    };
    const { branch, state, evaluated, isolationPages } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
      campaign: completed,
    });
    state.markCopySuspect({
      campaignId: completed.id,
      campaignName: completed.name,
      at: "2026-08-24T12:00:00.000Z",
      reason: "stale inconclusive",
    });
    state.upsertIsolationRun({
      id: "stale-aug-24",
      campaignId: completed.id,
      campaignName: completed.name,
      startedAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:00.000Z",
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason:
        "No standing inbox-test reading for the mailboxes this campaign is sending from.",
    });
    state.setCanonMissAlert(completed.id, "INCONCLUSIVE");

    evaluated.length = 0;
    const result = await branch.run();
    assert.deepEqual(
      evaluated,
      [],
      "COMPLETED leftover suspects must not re-enter evaluate",
    );
    assert.equal(result.evaluated, 0);
    assert.deepEqual(isolationPages, [], "no isolation Slack page on COMPLETED");
  });

  it("does not page INCONCLUSIVE when evaluate is called on a PAUSED campaign (D165)", async () => {
    const { branch, isolationPages } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 50,
      mailboxPlacement: "UNKNOWN",
      campaign: { ...AIRPODS, status: "PAUSED" },
    });
    const run = await branch.evaluate(AIRPODS.id, { campaignInSpam: true });
    assert.equal(run.verdict, "INCONCLUSIVE");
    assert.deepEqual(
      isolationPages,
      [],
      "PAUSED evaluate must not Slack-page INCONCLUSIVE",
    );
  });

  it("COPY vs INFRA still follows decideIsolationVerdict", async () => {
    const copy = await buildBranch({ knownGoodInbox: 95, canaryInbox: 0 });
    const copyRun = await copy.branch.evaluate(AIRPODS.id, { campaignInSpam: true });
    assert.equal(copyRun.verdict, "COPY");
    assert.equal(copyRun.teardownStarted, true);

    const infra = await buildBranch({ knownGoodInbox: 10, canaryInbox: 0 });
    const infraRun = await infra.branch.evaluate(AIRPODS.id, { campaignInSpam: true });
    assert.equal(infraRun.verdict, "INFRA");
    assert.equal(infraRun.teardownStarted, false);
    assert.equal(infra.teardowns.length, 0);
  });

  it("re-evaluates a PAUSED INCONCLUSIVE suspect even with evaluatedAt (D164)", async () => {
    const { branch, state, evaluated } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
      campaign: SALESGLIDER,
    });
    state.markCopySuspect({
      campaignId: SALESGLIDER.id,
      campaignName: SALESGLIDER.name,
      at: "2026-08-26T12:00:00.000Z",
      evaluatedAt: "2026-08-26T12:05:00.000Z",
      reason: "missing unwarmed senders with that copy",
    });
    state.upsertIsolationRun({
      id: "06371d1b-768f-4e3b-9c52-ee08019f8341",
      campaignId: SALESGLIDER.id,
      campaignName: SALESGLIDER.name,
      startedAt: "2026-08-26T12:00:00.000Z",
      updatedAt: "2026-08-26T12:05:00.000Z",
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason: "missing unwarmed senders with that copy",
    });

    const result = await branch.run();
    assert.deepEqual(
      evaluated,
      [SALESGLIDER.id],
      "PAUSED + evaluatedAt must not lock INCONCLUSIVE out of the 15-minute loop",
    );
    assert.ok(result.evaluated >= 1);
  });

  it("does not blindly re-eval COPY/INFRA when hasOpenIsolation says owned", async () => {
    const { branch, state, evaluated } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
    });
    await branch.run();
    evaluated.length = 0;
    const owned = state.listCopySuspects().find((row) => row.campaignId === AIRPODS.id);
    assert.ok(owned?.evaluatedAt);
    assert.equal(state.latestIsolationRunForCampaign(AIRPODS.id)?.verdict, "COPY");

    const second = await branch.run();
    assert.deepEqual(evaluated, []);
    assert.equal(second.evaluated, 0);
  });

  it("heals a missing copy-canary testId so unwarmed scoring can finish", async () => {
    const { branch, state, healed } = await buildBranch({
      knownGoodInbox: 95,
      canaryInbox: 0,
      campaign: SALESGLIDER,
      canaryTestId: null,
    });
    assert.equal(state.getCopyCanaryTestId(SALESGLIDER.id), undefined);

    const run = await branch.evaluate(SALESGLIDER.id, { campaignInSpam: true });
    assert.deepEqual(healed, [SALESGLIDER.id]);
    assert.equal(state.getCopyCanaryTestId(SALESGLIDER.id), `healed-${SALESGLIDER.id}`);
    assert.equal(run.verdict, "COPY", "healed testId lets the unwarmed reading finish");
  });
});
