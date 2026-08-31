import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Guards for RETIRED machinery — decisions whose whole point is that code
 * stays deleted and behaviours stay absent (D129 and friends). A failure
 * here means something Josh retired is creeping back. Live-rule guards are
 * in canon.test.ts, process guards in meta.test.ts.
 */

/** Format a failure as a hand-off rather than an assertion error. */
function stop(decision: string, problem: string): string {
  return [
    "",
    "STOP — this reverses one of Josh's decisions.",
    `  Decision: ${decision}`,
    `  Problem:  ${problem}`,
    "This is not a bug. See DECISIONS.md for the reasoning and the tradeoff.",
    "Check with Josh before changing it. Do not delete this guard to go green.",
    "",
  ].join("\n");
}

describe("owner intent — D44 hold rebuild", () => {
  it("D44 historical (ran 2026-08-21; deleted D129)", async () => {
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(new URL("../services/restBaselineRebuild.ts", import.meta.url)),
      stop(
        "The hold rebuild ran once and its code is gone (D44/D129).",
        "restBaselineRebuild.ts exists again.",
      ),
    );
  });
});

describe("owner intent — D61 Vasco trim and client wipe", () => {
  it("D61 historical (ran 2026-08-24; deleted D129)", async () => {
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(new URL("../services/clientWipe.ts", import.meta.url)),
      stop(
        "The Vasco trim and GXA/MSRS/Nieto wipe ran once; the destructive one-shot is deleted so a lost state file can never re-fire it (D61/D129).",
        "clientWipe.ts exists again.",
      ),
    );
  });
});

describe("owner intent — D79 no per-sender bounce pull", () => {
  it("D79: D5's 5%/50 pull machinery is deleted; the D90 loop is the bounce control", async () => {
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(new URL("../services/remediation.ts", import.meta.url)),
      stop(
        "The per-sender rotation engine is deleted (D79/D130).",
        "remediation.ts exists again.",
      ),
    );
  });
});

describe("owner intent — D88 bounce pause bands retired", () => {
  it("D88: the 20/7 pause bands stay unused; no Smartlead off-write exists (D157)", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    const autostop = await read("../services/campaignBounceAutostop.ts");
    assert.doesNotMatch(
      autostop,
      /shouldAutostopCampaignForBounce/,
      stop(
        "The bounce loop does not score a 20/7 band (D88).",
        "campaignBounceAutostop.ts still imports shouldAutostopCampaignForBounce.",
      ),
    );
    // D157 retired the off-write this guard used to require: the API
    // discards bounce_autopause_threshold, so the loop writes nothing.
    assert.doesNotMatch(
      autostop,
      /updateCampaignSettings/,
      stop(
        "The bounce loop writes no Smartlead settings (D157).",
        "campaignBounceAutostop.ts writes campaign settings again.",
      ),
    );

    const bandLib = await read("../lib/campaignBounceAutostop.ts");
    assert.doesNotMatch(
      bandLib,
      /campaignBounceAutostopThreshold|shouldAutostopCampaignForBounce|MID_PERCENT/,
      stop(
        "The 20/7 band helpers are deleted, not merely unused (D88/D129).",
        "lib/campaignBounceAutostop.ts encodes the retired bands again.",
      ),
    );
  });
});

describe("owner intent — D91 paused bounce hunt retired", () => {
  it("D91: monitor does not run bounce investigate", async () => {
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(
      index,
      /CampaignBounceInvestigateService/,
      stop(
        "Paused-campaign bounce investigate is retired (D91).",
        "index.ts still constructs CampaignBounceInvestigateService.",
      ),
    );
    assert.doesNotMatch(
      index,
      /bounce-investigate/,
      stop(
        "The bounce-investigate /run mode is retired (D91).",
        "index.ts still exposes bounce-investigate.",
      ),
    );
  });
});

describe("owner intent — D97 leftover signature Slack asks retired", () => {
  it("D97: Add %signature% is not a Slack allow kind and remind dismisses leftovers", async () => {
    const { slackKindForIsolationAction } = await import("../lib/slackAllow.js");
    assert.equal(
      slackKindForIsolationAction("add_signature_tag"),
      null,
      stop(
        "Add %signature% is not a Slack button (D97).",
        "add_signature_tag is mapped back onto copy_word and will post again.",
      ),
    );
    const actions = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/isolationActions.ts", import.meta.url), "utf8"),
    );
    assert.match(
      actions,
      /dismissPendingSignatureAsks/,
      stop(
        "Leftover signature asks are dismissed, not re-posted (D97).",
        "isolationActions.ts lost dismissPendingSignatureAsks.",
      ),
    );
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /dismissPendingSignatureAsks/,
      stop(
        "Boot dismisses leftover signature asks before the deploy remind (D97).",
        "index.ts no longer dismisses leftover Add %signature% asks.",
      ),
    );
  });
});

describe("owner intent — D109 morning activate", () => {
  it("D109 historical (ran 2026-08-26; deleted D129)", async () => {
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(new URL("../services/morningActivate.ts", import.meta.url)),
      stop(
        "The morning START ran once; the flag-less one-shot is deleted so a lost state file can never re-fire it past the launch bar (D109/D129).",
        "morningActivate.ts exists again.",
      ),
    );
  });
});

describe("owner intent — D129 retired machinery stays deleted", () => {
  it("D129: none of the retired services exist in the tree", async () => {
    const { access } = await import("node:fs/promises");
    for (const path of [
      "../services/heldPlacementTests.ts",
      "../services/restBaselineRebuild.ts",
      "../services/unhealthyReset.ts",
      "../services/clientWipe.ts",
      "../services/morningActivate.ts",
      "../services/campaignBounceInvestigate.ts",
      "../lib/clientWipe.ts",
      "../lib/holdProof.ts",
    ]) {
      await assert.rejects(
        access(new URL(path, import.meta.url)),
        stop(
          `Retired machinery is deleted, not parked (D127/D129): ${path}`,
          `${path} exists again — a retired service came back.`,
        ),
      );
    }
  });
});

describe("owner intent — D130 the rotation engine is gone", () => {
  it("D130: engine files stay deleted and no knob can revive a pull", async () => {
    const { access } = await import("node:fs/promises");
    for (const path of [
      "../services/remediation.ts",
      "../services/recoveryPool.ts",
      "../services/bcpClientRestore.ts",
      "../ops/manualRotation.ts",
      "../lib/holdOutcome.ts",
      "../lib/placementRotation.ts",
      "../lib/burnChecklist.ts",
    ]) {
      await assert.rejects(
        access(new URL(path, import.meta.url)),
        stop(
          `The rotation engine is deleted, not parked (D130): ${path}`,
          `${path} exists again.`,
        ),
      );
    }
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /D130 drain/,
      stop(
        "Boot drains leftover hold/swap residue so it cannot suppress staffing (D130).",
        "index.ts lost the D130 residue drain.",
      ),
    );
  });
});
