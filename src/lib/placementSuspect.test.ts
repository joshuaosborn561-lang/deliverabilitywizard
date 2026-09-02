import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isTerminalIsolationVerdict,
  liveCampaignForPlacementTrigger,
  placementIsolationHealth,
  placementSuspectReason,
  sameEspInboxUgly,
  shouldQueuePlacementSuspect,
  uglyWithoutIsolation,
} from "./placementSuspect.js";

const live = {
  id: 3847794,
  name: "TechEvo SFL Startup Owners AirPods",
  status: "ACTIVE",
};

describe("placement suspect mapping (D158)", () => {
  it("maps a canary-copy test name to the ACTIVE live campaign, not the shell", () => {
    const target = liveCampaignForPlacementTrigger({
      testName: "Canary copy: #3847794 TechEvo SFL Startup Owners AirPods",
      testCampaignId: 999001,
      campaigns: [
        live,
        { id: 999001, name: "Canary shell: #3847794 AirPods", status: "PAUSED" },
      ],
    });
    assert.deepEqual(target, {
      campaignId: 3847794,
      campaignName: live.name,
      source: "canary-copy",
    });
  });

  it("maps a live placement test on an ACTIVE campaign", () => {
    const target = liveCampaignForPlacementTrigger({
      testName: "TechEvo SFL Startup Owners AirPods",
      testCampaignId: 3847794,
      campaigns: [live],
    });
    assert.equal(target?.campaignId, 3847794);
    assert.equal(target?.source, "live-placement");
  });

  it("skips shells, pod-control tests, and non-ACTIVE campaigns", () => {
    assert.equal(
      liveCampaignForPlacementTrigger({
        testName: "Pod control: TechEvo A",
        testCampaignId: 3847794,
        campaigns: [live],
      }),
      undefined,
    );
    assert.equal(
      liveCampaignForPlacementTrigger({
        testName: "Isolation: #3847794 word 1",
        testCampaignId: 3847794,
        campaigns: [live],
      }),
      undefined,
    );
    assert.equal(
      liveCampaignForPlacementTrigger({
        testName: "Canary copy: #3847794 AirPods",
        campaigns: [{ ...live, status: "PAUSED" }],
      }),
      undefined,
    );
    assert.equal(
      liveCampaignForPlacementTrigger({
        testName: "Canary shell leftover",
        testCampaignId: 999001,
        campaigns: [
          { id: 999001, name: "Canary shell: #3847794 AirPods", status: "ACTIVE" },
        ],
      }),
      undefined,
    );
  });
});

describe("placement suspect queue gates (D158)", () => {
  it("treats any same-ESP provider under the live bar as ugly", () => {
    assert.equal(
      sameEspInboxUgly(
        [
          { name: "Gmail", inboxPercent: 0 },
          { name: "Outlook", inboxPercent: 100 },
        ],
        80,
      ),
      true,
    );
    assert.equal(
      sameEspInboxUgly(
        [
          { name: "Gmail", inboxPercent: 90 },
          { name: "Outlook", inboxPercent: 85 },
        ],
        80,
      ),
      false,
    );
    assert.equal(sameEspInboxUgly([], 80), false);
  });

  it("does not re-queue an unevaluated suspect, an open hunt, or a covering COPY/INFRA run", () => {
    assert.equal(shouldQueuePlacementSuspect({}), true);
    assert.equal(
      shouldQueuePlacementSuspect({
        existing: { evaluatedAt: undefined },
      }),
      false,
    );
    assert.equal(
      shouldQueuePlacementSuspect({
        openRun: { teardownStarted: true, verdict: "COPY" },
      }),
      false,
    );
    assert.equal(
      shouldQueuePlacementSuspect({
        openRun: { verdict: "INFRA" },
      }),
      false,
    );
    assert.equal(
      shouldQueuePlacementSuspect({
        existing: { evaluatedAt: "2026-08-26T12:00:00.000Z" },
        openRun: { verdict: "COPY", teardownStarted: true },
      }),
      false,
    );
  });

  it("re-queues when evaluatedAt is set but the latest run is INCONCLUSIVE (D163)", () => {
    assert.equal(
      shouldQueuePlacementSuspect({
        existing: { evaluatedAt: "2026-08-26T12:00:00.000Z" },
      }),
      true,
      "evaluatedAt alone is not a lock",
    );
    assert.equal(
      shouldQueuePlacementSuspect({
        existing: { evaluatedAt: "2026-08-26T12:00:00.000Z" },
        openRun: { verdict: "INCONCLUSIVE" },
      }),
      true,
      "Goliath Education: COPY then INCONCLUSIVE must re-queue the still-ugly canary",
    );
    assert.equal(
      shouldQueuePlacementSuspect({
        existing: { evaluatedAt: "2026-08-28T00:00:00.000Z" },
        openRun: { verdict: "HEALTHY" },
      }),
      true,
      "HEALTHY does not cover a still-ugly reading — callers only ask when ugly",
    );
  });

  it("names the weak ESPs in the suspect reason", () => {
    assert.match(
      placementSuspectReason(
        "canary-copy",
        [{ name: "Gmail", inboxPercent: 0 }],
        80,
      ),
      /Canary-copy same-ESP under 80% \(Gmail 0%\)/,
    );
  });

  it("treats COPY/INFRA/HEALTHY as terminal and INCONCLUSIVE as not", () => {
    assert.equal(isTerminalIsolationVerdict("COPY"), true);
    assert.equal(isTerminalIsolationVerdict("INFRA"), true);
    assert.equal(isTerminalIsolationVerdict("HEALTHY"), true);
    assert.equal(isTerminalIsolationVerdict("INCONCLUSIVE"), false);
  });
});

describe("placement isolation health (D159)", () => {
  const score = {
    campaignId: 3847794,
    campaignName: live.name,
    source: "canary-copy" as const,
    testId: "526826",
    inboxPercent: 0,
  };

  it("lists ugly campaigns with no suspect and no isolation run", () => {
    const holes = uglyWithoutIsolation({
      scores: [score],
      suspects: [],
      latestRun: () => undefined,
      threshold: 80,
    });
    assert.equal(holes.length, 1);
    assert.equal(holes[0]?.campaignId, 3847794);
  });

  it("hides a campaign that already has an open suspect or COPY run", () => {
    assert.deepEqual(
      uglyWithoutIsolation({
        scores: [score],
        suspects: [{ campaignId: 3847794 }],
        latestRun: () => undefined,
        threshold: 80,
      }),
      [],
    );
    assert.deepEqual(
      uglyWithoutIsolation({
        scores: [score],
        suspects: [],
        latestRun: () => ({ verdict: "COPY", teardownStarted: true }),
        threshold: 80,
      }),
      [],
    );
  });

  it("exposes lastOk, scored, ugly, and holes for /health", () => {
    const snap = placementIsolationHealth({
      scores: [score, { ...score, campaignId: 1, inboxPercent: 95, testId: "1" }],
      suspects: [],
      latestRun: () => undefined,
      threshold: 80,
      lastOkAt: "2026-09-02T02:30:00.000Z",
    });
    assert.equal(snap.lastOkAt, "2026-09-02T02:30:00.000Z");
    assert.equal(snap.scored, 2);
    assert.equal(snap.ugly, 1);
    assert.equal(snap.uglyWithoutIsolation.length, 1);
  });
});
