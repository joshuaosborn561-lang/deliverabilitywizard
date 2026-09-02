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
}) {
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
  state.setCopyCanaries(AIRPODS.id, ["canary@g.test"], "canary-3847794");

  const evaluated: number[] = [];
  const teardowns: number[] = [];
  const config = loadConfig({} as NodeJS.ProcessEnv);

  const smartlead = {
    listCampaigns: async () => [AIRPODS],
    getCampaign: async (id: number) =>
      id === AIRPODS.id ? AIRPODS : { id, name: `Campaign ${id}`, status: "ACTIVE" },
    getCampaignEmailAccounts: async () => [
      { id: 1, from_email: "a@techevo.test" },
    ],
  };
  const smartDelivery = {
    listTests: async () => [
      {
        id: "canary-3847794",
        test_name: `Canary copy: #${AIRPODS.id} ${AIRPODS.name}`,
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
  const slack = {
    notifyIsolationVerdict: async () => undefined,
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
  return { branch, state, evaluated, teardowns, armed };
}

describe("IsolationBranchService placement queue (D158)", () => {
  it("canary-copy under 80% marks a suspect and evaluates the live campaign", async () => {
    const { branch, state, evaluated, teardowns } = await buildBranch({
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
});
