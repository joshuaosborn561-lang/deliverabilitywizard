import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isTerminalIsolationVerdict,
  liveCampaignForPlacementTrigger,
  placementSuspectReason,
  sameEspInboxUgly,
  shouldQueuePlacementSuspect,
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

  it("does not re-queue an evaluated suspect, an open hunt, or a terminal run", () => {
    assert.equal(shouldQueuePlacementSuspect({}), true);
    assert.equal(
      shouldQueuePlacementSuspect({
        existing: { evaluatedAt: undefined },
      }),
      false,
    );
    assert.equal(
      shouldQueuePlacementSuspect({
        existing: { evaluatedAt: "2026-09-01T18:00:00.000Z" },
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
        openRun: { verdict: "INCONCLUSIVE" },
      }),
      true,
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
