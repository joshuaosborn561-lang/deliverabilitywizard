import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { isExcluded } from "../services/campaignTopUp.js";
import { scoreNameMatch, MATCH_THRESHOLD } from "../lib/nameMatch.js";
import { shouldRotateForBounces } from "../lib/bounceRate.js";

/**
 * The repo owner's product decisions. A failure here means someone is
 * reversing a deliberate call, not that they hit a bug. See DECISIONS.md.
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

/** Config as it loads with no environment set — the shipped defaults. */
const defaults = loadConfig({} as NodeJS.ProcessEnv);

describe("owner intent", () => {
  it("D4: spend approval defaults to on", () => {
    assert.equal(
      defaults.requireSpendApproval,
      true,
      stop(
        "Real-money spend is held for human approval (D4).",
        "Spend approval now defaults to off, so mailbox purchases would run unattended.",
      ),
    );
  });

  it("D6 retired by D51/D59/D130: there is no recovery hold", () => {
    assert.ok(
      !("recoveryHoldDays" in defaults),
      stop(
        "Benching is gone — pulls are kill-only and holds were wiped (D51/D59/D130).",
        "config grew recoveryHoldDays back.",
      ),
    );
  });

  it("D1/D50: pool warmup is 21 days from InboxKit import", () => {
    assert.equal(
      defaults.poolWarmupDays,
      21,
      stop(
        "A mailbox owes 21 days from InboxKit import before going live (D1 clock, D50 duration).",
        `Pool warmup is now ${defaults.poolWarmupDays} days.`,
      ),
    );
    assert.equal(
      defaults.campaignMinWarmupDays,
      21,
      stop(
        "21 days is the warmed-vs-unwarmed clock (D50). D51 stopped the gate from pulling.",
        `Campaign min warmup is now ${defaults.campaignMinWarmupDays} days.`,
      ),
    );
  });

  it("D5/D51: 80% placement and 5% bounce stay readings, not live pulls", () => {
    assert.equal(
      defaults.remediationInboxThreshold,
      80,
      stop(
        "80% same-ESP is still the placement *reading* (D5/D51). It does not pull.",
        `Placement threshold is now ${defaults.remediationInboxThreshold}%.`,
      ),
    );
    assert.equal(
      defaults.bounceRateThreshold,
      5,
      stop(
        "5% bounce is still the bounce *reading* (D5/D51). It does not pull.",
        `Bounce threshold is now ${defaults.bounceRateThreshold}%.`,
      ),
    );
    assert.ok(
      !("enableLegacyMailboxPulls" in defaults),
      stop(
        "The legacy pull machinery is deleted, not merely off (D51/D130).",
        "config grew enableLegacyMailboxPulls back — is the old engine returning?",
      ),
    );
  });

  it("D32: never rotate on blended placement — same-ESP scoring stays on", async () => {
    assert.equal(
      defaults.scoreSameEspOnly,
      true,
      stop(
        "Placement readings use same-ESP scores only (D32).",
        "SCORE_SAME_ESP_ONLY is off, so blended all-ESP scores can mislead readings again.",
      ),
    );
    // There is no placement rotation left at all (D51/D130) — the blended
    // score cannot bench anyone because nothing benches anyone.
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(new URL("../lib/placementRotation.ts", import.meta.url)),
      stop(
        "Placement rotation is deleted, not gated (D51/D130).",
        "lib/placementRotation.ts exists again.",
      ),
    );
  });

  it("D5: a bounce rate is only evidence above the sample floor", () => {
    // One bounce in three is 33% and means nothing.
    assert.equal(
      shouldRotateForBounces({ email: "a@x.com", bounceRate: 33, sent: 3 }, 5, 50),
      false,
      stop(
        "A bounce rate needs at least 50 sends behind it (D5).",
        "A tiny sample now benches a sender, so a newly warmed mailbox can be pulled on its first bad send.",
      ),
    );
  });

  it("D45: placement-test quota defaults to unlimited (0)", () => {
    assert.equal(
      defaults.totalTestQuota,
      0,
      stop(
        "SmartDelivery tests are uncapped by default (D45).",
        `Quota default is now ${defaults.totalTestQuota}, which would re-cap the unlimited plan.`,
      ),
    );
    assert.doesNotThrow(
      () => loadConfig({ TOTAL_TEST_QUOTA: "0" }),
      stop(
        "TOTAL_TEST_QUOTA=0 must load as unlimited (D45).",
        "Config still rejects 0 (old D8 .positive()), so a post-merge Railway clear would crash.",
      ),
    );
  });

  it("D45: scanner / held / rest must not block when quota is 0", async () => {
    const { quotaWouldBlock } = await import("../lib/testQuota.js");
    assert.equal(
      quotaWouldBlock(0, 999, 80),
      false,
      stop(
        "Quota 0 is unlimited — do not block creates (D45).",
        "quotaWouldBlock(0, …) is true again, so scanner/held/rest would refuse tests.",
      ),
    );
    assert.equal(
      quotaWouldBlock(120, 118, 3),
      true,
      stop(
        "A positive quota still caps (D8/D45).",
        "Positive TOTAL_TEST_QUOTA no longer blocks when exhausted.",
      ),
    );
  });

  it("D8: recurring daily autos stay on with ≤50 senders and reconciler", () => {
    assert.equal(
      defaults.autoPlacementTests,
      true,
      stop(
        "Placement tests are recurring automated schedules (D8).",
        "AUTO_PLACEMENT_TESTS now defaults off, so campaigns lose day-over-day inbox tracking.",
      ),
    );
    assert.equal(
      defaults.placementTestEveryDays,
      1,
      stop(
        "Recurring placement tests re-run daily (D8).",
        `every_days is now ${defaults.placementTestEveryDays}.`,
      ),
    );
    assert.equal(
      defaults.maxMailboxesPerTest,
      50,
      stop(
        "Each placement test is capped at 50 senders (D8 / SmartDelivery).",
        `Max mailboxes per test is now ${defaults.maxMailboxesPerTest}.`,
      ),
    );
    assert.equal(
      defaults.enableTestReconciler,
      true,
      stop(
        "Recurring tests stop when the campaign is no longer active (D8).",
        "Test reconciler now defaults off, so paused campaigns keep burning test runs.",
      ),
    );
  });

  it("D7 retired by D58/D82/D128: top-up on; no global 50 floor anywhere", async () => {
    assert.equal(
      defaults.enableCampaignTopUp,
      true,
      stop(
        "Thin campaigns are refilled automatically (D7).",
        "Top-up now defaults off, so a campaign that launches thin stays thin.",
      ),
    );
    // The floor is HALF that client's inboxes (clientStaffFloor, D58/D82).
    // minCampaignSenders survives only so a stale Railway var cannot crash
    // boot; nothing may use it as a staffing number (D128).
    const health = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/campaignHealth.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(
      health,
      /floor: this\.config\.minCampaignSenders/,
      stop(
        "Campaign health floors come from clientStaffFloor, never the dead 50 (D58/D82/D128).",
        "campaignHealth.ts uses config.minCampaignSenders as a floor again.",
      ),
    );
  });

  it("D25: campaign health loop defaults on with a fast cron", () => {
    assert.equal(
      defaults.enableCampaignHealth,
      true,
      stop(
        "Campaign health staffing loop stays on (D25).",
        "Health now defaults off, so thin/paused campaigns wait on the slow monitor.",
      ),
    );
    assert.equal(
      defaults.cronHealth,
      "*/15 * * * *",
      stop(
        "Health cron runs every 15 minutes (D25).",
        `Health cron is now ${defaults.cronHealth}.`,
      ),
    );
  });


  it("D40/D91/D129: the paused-campaign bounce hunt does not exist", async () => {
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(new URL("../services/campaignBounceInvestigate.ts", import.meta.url)),
      stop(
        "D91 retired the D29 hunt; D129 deleted the file.",
        "campaignBounceInvestigate.ts exists again — the retired hunt is back in the tree.",
      ),
    );
  });

  it("D28/D36 retired by D69/D93/D96/D129: no provider-split copy classifier", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../lib/copySignal.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      src,
      /classifyCopySignal|copy_likely|shouldDeferSenderRotationForCopy/,
      stop(
        "Provider divergence is never a Slack or rotation driver (D69/D93/D96).",
        "copySignal.ts grew the D28/D36 classifier back.",
      ),
    );
  });


  it("D39 retired by D51/D59/D129: held-test machinery does not exist", async () => {
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(new URL("../services/heldPlacementTests.ts", import.meta.url)),
      stop(
        "Held/rest recovery tests are retired; coverage lives on the shells (D56/D114).",
        "heldPlacementTests.ts exists again.",
      ),
    );
  });

  it("D7: exclusions match a campaign id exactly, never by substring", () => {
    const msrs = { id: 3628940, name: "MSRS2 Ticket Offer" };
    assert.equal(
      isExcluded(msrs, ["628940"]),
      false,
      stop(
        "Excluded campaign ids match exactly (D7).",
        "A partial id now excludes a campaign, so an unrelated campaign could be silently skipped.",
      ),
    );
    assert.equal(
      isExcluded(msrs, ["3628940"]),
      true,
      stop(
        "Excluded campaign ids match exactly (D7).",
        "An exact id no longer excludes its campaign.",
      ),
    );
  });

  it("D19: cleartechco.com is an explicit pre-warmed fleet domain", () => {
    assert.ok(
      defaults.extraGenericDomains.includes("cleartechco.com"),
      stop(
        "cleartechco.com is pre-warmed and exempt from the under-warmed pull (D19).",
        `EXTRA_GENERIC_DOMAINS is now ${defaults.extraGenericDomains.join(",")}.`,
      ),
    );
  });

  it("D2: a generic from-name matches the whole fleet, not one mailbox", () => {
    // Same from-name across many domains must all clear the threshold.
    for (const email of [
      "harmony.norris@crosslaunchco.com",
      "h.norris@meetconnectnow.com",
      "harm.norris@getintroducednow.com",
    ]) {
      const score = scoreNameMatch("harmony norris", {
        fromName: "Harmony Norris",
        email,
      }).score;
      assert.ok(
        score >= MATCH_THRESHOLD,
        stop(
          "Every mailbox carrying a generic from-name is registered (D2).",
          `${email} scores ${score}, below the ${MATCH_THRESHOLD} threshold, so it would be left out of the pool.`,
        ),
      );
    }
  });

  it("D2: the threshold still keeps a different person out", () => {
    const score = scoreNameMatch("harmony norris", {
      fromName: "Marcus Norris",
      email: "marcus.norris@x.com",
    }).score;
    assert.ok(
      score < MATCH_THRESHOLD,
      stop(
        "Matching a fleet must not sweep in unrelated people (D2).",
        `A different person sharing the surname scores ${score} and would be handed to clients as a generic.`,
      ),
    );
  });
});

describe("owner intent — mailbox settings", () => {
  it("D11: mailbox send cap is 30 per day", () => {
    assert.equal(
      defaults.messagePerDay,
      30,
      stop(
        "Every mailbox sends at most 30 campaign emails per day (D11).",
        `The cap is now ${defaults.messagePerDay}/day, changing fleet-wide volume.`,
      ),
    );
    assert.equal(
      defaults.enforceMailboxSettings,
      true,
      stop(
        "Mailbox send cap and warmup are converged on every run (D11).",
        "Enforcement is now off, so mailboxes drift back to whatever default they were created with.",
      ),
    );
  });

  it("D24: Message Per Day is 30 and warmups are not included in that field", () => {
    assert.equal(
      defaults.messagePerDay,
      30,
      stop(
        "Smartlead Message Per Day (warmups not included) is 30 (D24).",
        `Message Per Day is now ${defaults.messagePerDay}.`,
      ),
    );
    assert.equal(
      defaults.warmupTotalPerDay,
      20,
      stop(
        "Warmup allotment stays on its own field at 20/day (D24).",
        `Warmup is now ${defaults.warmupTotalPerDay}/day.`,
      ),
    );
  });

  it("D30: every mailbox holds a 10-minute minimum send gap", () => {
    assert.equal(
      defaults.mailboxMinTimeGapMins,
      10,
      stop(
        "Minimum time gap is 10 minutes on every mailbox (D30).",
        `Min gap is now ${defaults.mailboxMinTimeGapMins}m.`,
      ),
    );
  });

  it("D35: health enforces mailbox min gap every pass, not only every 6h", async () => {
    const fs = await import("node:fs");
    const indexSrc = fs.readFileSync(
      new URL("../index.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      indexSrc,
      /runGapEnforce/,
      stop(
        "Mailbox min gap is enforced on every health pass (D35).",
        "index.ts no longer calls runGapEnforce — gap drift can sit for hours again.",
      ),
    );
    const settingsSrc = fs.readFileSync(
      new URL("../services/mailboxSettings.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      settingsSrc,
      /mode:\s*"gap"|MailboxSettingsMode/,
      stop(
        "Mailbox min gap is enforced on every health pass (D35).",
        "mailboxSettings lost the gap-only mode used by the health cron.",
      ),
    );
  });
});

describe("owner intent — auto bug remediator", () => {
  it("D21: remediator defaults on with auto-merge after threshold", () => {
    assert.equal(
      defaults.enableBugRemediator,
      true,
      stop(
        "Repeated code failures launch a Cursor fix PR (D21).",
        "Auto bug remediator now defaults off, so production errors wait on a human again.",
      ),
    );
    assert.equal(
      defaults.bugRemediatorMinHits,
      2,
      stop(
        "Two hits of the same fingerprint launch remediation (D21).",
        `Min hits is now ${defaults.bugRemediatorMinHits}.`,
      ),
    );
    assert.equal(
      defaults.bugRemediatorCooldownHours,
      24,
      stop(
        "Same fingerprint waits 24h before re-launch (D21).",
        `Cooldown is now ${defaults.bugRemediatorCooldownHours}h.`,
      ),
    );
    assert.equal(
      defaults.bugRemediatorAutoMerge,
      true,
      stop(
        "Remediator merges green PRs so Josh does not babysit (D21).",
        "Auto-merge now defaults off.",
      ),
    );
  });
});

describe("owner intent — sender supply", () => {
  it("D9: a generic is taken only while its donor keeps the floor", () => {
    const floor = 50;
    const counts = new Map<number, number>([
      [1, 100], // TechEvo: 50 to spare
      [2, 50], // exactly at the floor — untouchable
      [3, 51], // one to spare
    ]);
    const reassignable = (campaigns: number[]) =>
      campaigns.every((id) => (counts.get(id) ?? 0) - 1 >= floor);

    assert.equal(
      reassignable([1]),
      true,
      stop(
        "Surplus senders above the floor are available to move (D9).",
        "A campaign with 100 senders is being treated as untouchable, so surplus cannot be redistributed.",
      ),
    );
    assert.equal(
      reassignable([2]),
      false,
      stop(
        "A campaign is never pulled below the floor (D9).",
        "A campaign sitting exactly at 50 senders would be stripped to 49.",
      ),
    );
    assert.equal(reassignable([3]), true, "51 may give up one and hold 50");
    assert.equal(
      reassignable([1, 2]),
      false,
      "a sender on several campaigns is only movable if every donor holds",
    );
  });
});

describe("owner intent — D41 beanstalk rotation", () => {
  it("D41: client rest defaults on; rest tests retired (D129)", () => {
    assert.equal(
      defaults.enableClientRest,
      true,
      stop(
        "Client inboxes rest 2 weeks on / 2 weeks off (D41/D43).",
        "ENABLE_CLIENT_REST now defaults off, so client inboxes stay on campaigns every week.",
      ),
    );
  });

  it("D41/D50: fresh, pool, and campaign-min warmup are all 21 days", () => {
    assert.equal(
      defaults.freshInboxWarmupDays,
      21,
      stop(
        "Fresh InboxKit inboxes owe 21 days before a live campaign (D41).",
        `Fresh warmup is now ${defaults.freshInboxWarmupDays} days.`,
      ),
    );
    assert.equal(
      defaults.poolWarmupDays,
      21,
      stop(
        "Pool warmup is 21 days from InboxKit import (D50).",
        `Pool warmup is now ${defaults.poolWarmupDays} days.`,
      ),
    );
    assert.equal(
      defaults.campaignMinWarmupDays,
      21,
      stop(
        "MIN_CAMPAIGN_WARMUP_DAYS is 21 (D50). Fresh boxes use the same clock.",
        `Campaign min warmup is now ${defaults.campaignMinWarmupDays} days.`,
      ),
    );
  });

  it("D41/D79: bounce warn is 2% (a reading); the per-sender pull is deleted", () => {
    assert.equal(
      defaults.bounceRateWarnThreshold,
      2,
      stop(
        "Bounce warns at 2% without pulling (D41).",
        `Warn threshold is now ${defaults.bounceRateWarnThreshold}%.`,
      ),
    );
    assert.ok(
      !("enableBounceRotation" in defaults),
      stop(
        "D5's per-sender pull machinery is deleted, not merely off (D79/D130).",
        "config grew enableBounceRotation back.",
      ),
    );
  });

  it("D43: canary is not in this loop", () => {
    assert.equal(
      "canaryCampaignDays" in defaults,
      false,
      stop(
        "Canary launch is another project (D43).",
        "Canary config is still on the live rest path.",
      ),
    );
  });
});

describe("owner intent — D43 rest model", () => {
  it("D43: A/B rest is client inboxes only; generics use a send clock", async () => {
    const { isRestEligibleMailbox, isClientInbox } = await import(
      "../lib/clientInbox.js"
    );
    const fleet = {
      extraGenericMailboxes: ["harmony norris"],
      extraGenericDomains: [
        "crosslaunchco.com",
        "crossscaleco.com",
        "cleartechco.com",
      ],
    };
    assert.equal(
      isClientInbox(
        { client_id: 9, from_name: "Harmony Norris" },
        "harmony@crosslaunchco.com",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
      stop(
        "Fleet generics stay non-client (D43).",
        "A fleet domain is now counted as a client inbox.",
      ),
    );
    assert.equal(
      isRestEligibleMailbox(
        { client_id: 9, from_name: "Harmony Norris" },
        "harmony@crosslaunchco.com",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
      stop(
        "Generics do not ride the client A/B fortnight (D43).",
        "Fleet generics are A/B rest-eligible again.",
      ),
    );
    assert.equal(
      defaults.enableGenericSendRest,
      true,
      stop(
        "Generics sit after ~14 days of live send (D43).",
        "ENABLE_GENERIC_SEND_REST now defaults off.",
      ),
    );
    assert.equal(
      defaults.genericSendRestDays,
      14,
      stop(
        "Generic send clock is 14 days (D43).",
        `Generic send rest is now ${defaults.genericSendRestDays} days.`,
      ),
    );
    assert.equal(
      defaults.campaignEspMixMinPercent,
      30,
      stop(
        "Top-up keeps ~30% Google and ~30% Microsoft (D43).",
        `ESP mix floor is now ${defaults.campaignEspMixMinPercent}%.`,
      ),
    );
  });
});

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

describe("owner intent — D46 launch bar", () => {
  it("D46: launch bar is 85%; live pull stays 80%", async () => {
    const { campaignSetupPrompt } = await import(
      "../ops/campaignSetupPrompt.js"
    );
    const prompt = campaignSetupPrompt();
    assert.match(
      prompt,
      /85%/,
      stop(
        "New campaigns launch at 85% same-ESP (D46).",
        "campaignSetupPrompt no longer states the 85% launch bar.",
      ),
    );
    assert.match(
      prompt,
      /80%/,
      stop(
        "Live pull stays 80% same-ESP (D32/D46).",
        "campaignSetupPrompt dropped the live 80% bar.",
      ),
    );
    assert.equal(
      defaults.remediationInboxThreshold,
      80,
      stop(
        "Health still pulls at 80%, not 85% (D32/D46).",
        `Remediation threshold is now ${defaults.remediationInboxThreshold}%.`,
      ),
    );
  });
});

describe("owner intent — D47 plain English Slack", () => {
  it("D47: Slack templates do not use internal jargon", async () => {
    const { SlackClient } = await import("../clients/slack.js");
    const { slackJargonHits } = await import("../lib/slackPlainEnglish.js");
    const sent: string[] = [];
    const client = new SlackClient({ channelLabel: "#test" });
    (client as unknown as { send: (t: string) => Promise<void> }).send = async (
      text: string,
    ) => {
      sent.push(text);
    };
    await client.notifyQuotaBlocked({
      used: 1,
      quota: 1,
      needed: 1,
      campaigns: [],
    });
    await client.notifyPlacementResult({
      threshold: 80,
      providers: [{ name: "Gmail", inboxPercent: 10 }],
      autoRemediation: true,
      remediationThreshold: 80,
      holdDays: 14,
      senders: [{ email: "a@x.com", inboxPercent: 10 }],
    });
    const hits = sent.flatMap((t) => slackJargonHits(t));
    assert.deepEqual(
      hits,
      [],
      stop(
        "Slack that people read is plain English (D47).",
        `Jargon leaked into Slack: ${hits.join(", ")}`,
      ),
    );
  });
});

describe("owner intent — D48 isolation", () => {
  it("D48: isolation reports only; tests are unlimited and do not wait for seed approval", async () => {
    assert.equal(
      defaults.enablePodControls,
      true,
      stop(
        "Standing pod controls start on their own (D48).",
        "ENABLE_POD_CONTROLS now defaults off.",
      ),
    );
    assert.equal(
      defaults.enableCopyIsolation,
      true,
      stop(
        "Copy teardown starts on its own when the verdict is copy (D48).",
        "ENABLE_COPY_ISOLATION now defaults off.",
      ),
    );
    assert.equal(
      defaults.totalTestQuota,
      0,
      stop(
        "Isolation must not re-cap SmartDelivery tests (D45/D48).",
        `TOTAL_TEST_QUOTA default is ${defaults.totalTestQuota}.`,
      ),
    );
    assert.equal(
      "podControlSeedApproved" in defaults,
      false,
      stop(
        "Do not hold isolation tests for seed approval (D48).",
        "A seed-approval config flag is back.",
      ),
    );

    const { SmartleadClient } = await import("../clients/smartlead.js");
    const { IsolationAttachBlockedError } = await import(
      "../lib/isolationDomain.js"
    );
    const client = new SmartleadClient("test-key");
    client.setIsolationDenylist([99]);
    await assert.rejects(
      () => client.addEmailAccountsToCampaign(1, [99]),
      IsolationAttachBlockedError,
      stop(
        "Isolation-domain mailboxes never attach to a campaign (D48).",
        "The denylist did not block addEmailAccountsToCampaign.",
      ),
    );

    const { decideIsolationVerdict, failedControlIsNeverCopy } = await import(
      "../lib/isolationVerdict.js"
    );
    const failing = decideIsolationVerdict({
      campaignInSpam: true,
      senderControls: ["SPAM"],
    });
    assert.equal(
      failing.verdict,
      "INFRA",
      stop(
        "A failing control is inboxes, not copy (D48).",
        `Verdict was ${failing.verdict}.`,
      ),
    );
    assert.equal(
      failedControlIsNeverCopy(failing),
      true,
      stop(
        "A failed control is never a copy finding (D48).",
        "COPY leaked from a failing control.",
      ),
    );

    const { isSingleVariable } = await import("../lib/copyVariants.js");
    assert.equal(
      isSingleVariable(
        { subject: "A", body: "B" },
        { subject: "C", body: "D" },
      ),
      false,
      stop(
        "A two-change variant is discarded (D48).",
        "Two-field edits now count as one variable.",
      ),
    );

    const { campaignSetupPrompt } = await import(
      "../ops/campaignSetupPrompt.js"
    );
    const prompt = campaignSetupPrompt();
    assert.match(
      prompt,
      /never edits the live sequence/i,
      stop(
        "Isolation is report-only on campaigns (D48).",
        "campaignSetupPrompt dropped the report-only rule.",
      ),
    );
    assert.match(
      prompt,
      /do not hold a copy teardown for seed approval/i,
      stop(
        "Copy teardown does not wait for seed approval (D48).",
        "campaignSetupPrompt still treats isolation tests as gated.",
      ),
    );
  });
});

describe("owner intent — D49 isolation autonomy", () => {
  it("D49: humans only for retire, buy, and copy; fleet needs several failing inboxes", async () => {
    const { canDecideIsolationAction } = await import(
      "../lib/isolationActors.js"
    );
    assert.equal(
      canDecideIsolationAction("buy_domains", "operator"),
      false,
      stop(
        "Only Josh can approve buying replacement domains (D49).",
        "Cayden can now approve a domain purchase.",
      ),
    );
    assert.equal(
      canDecideIsolationAction("retire_domain", "operator"),
      false,
      stop(
        "Only Josh can retire a domain (D49).",
        "Cayden can now retire a domain.",
      ),
    );
    assert.equal(
      canDecideIsolationAction("swap_copy", "operator"),
      true,
      stop(
        "Josh or Cayden can approve a one-word copy swap (D49).",
        "Cayden can no longer tap Make the changes.",
      ),
    );
    assert.equal(
      defaults.requireSpendApproval,
      true,
      stop(
        "Real-money spend still needs a human (D4/D49).",
        "Spend approval now defaults off.",
      ),
    );

    const { FLEET_MIN_FAILING_INBOXES, judgeDomainCycle } = await import(
      "../lib/domainControl.js"
    );
    assert.equal(
      FLEET_MIN_FAILING_INBOXES,
      3,
      stop(
        "A fleet domain needs several failing inboxes, not one (D49).",
        `Fleet fail floor is ${FLEET_MIN_FAILING_INBOXES}.`,
      ),
    );
    const oneBox = judgeDomainCycle(
      "crosslaunchco.com",
      [{ email: "a@crosslaunchco.com", placement: "SPAM" }],
      ["crosslaunchco.com"],
    );
    assert.equal(
      oneBox.domainFailed,
      false,
      stop(
        "One failing inbox does not kill a fleet domain (D49).",
        "A single mailbox fail now condemns the fleet.",
      ),
    );

    const { campaignSetupPrompt } = await import(
      "../ops/campaignSetupPrompt.js"
    );
    const prompt = campaignSetupPrompt();
    assert.match(
      prompt,
      /campaign in spam is a flag/i,
      stop(
        "Campaign spam is research, not a domain death sentence (D49).",
        "campaignSetupPrompt dropped the flag language.",
      ),
    );
    assert.match(
      prompt,
      /until Josh or Cayden tap Make the changes/i,
      stop(
        "Live copy changes only after Josh or Cayden approve (D49).",
        "campaignSetupPrompt no longer names the Make the changes tap.",
      ),
    );
  });
});

describe("owner intent — D50 live-send warmup", () => {
  it("D50: live-send warmup is 21 days; generic rest stays 14", () => {
    assert.equal(
      defaults.poolWarmupDays,
      21,
      stop(
        "Pool mailboxes owe 21 days from InboxKit import (D50).",
        `Pool warmup is now ${defaults.poolWarmupDays} days.`,
      ),
    );
    assert.equal(
      defaults.campaignMinWarmupDays,
      21,
      stop(
        "21 days is the warmed-vs-unwarmed clock (D50).",
        `Campaign min warmup is now ${defaults.campaignMinWarmupDays} days.`,
      ),
    );
    assert.equal(
      defaults.freshInboxWarmupDays,
      21,
      stop(
        "Fresh InboxKit inboxes still owe 21 days (D41/D50).",
        `Fresh warmup is now ${defaults.freshInboxWarmupDays} days.`,
      ),
    );
    assert.equal(
      defaults.genericSendRestDays,
      14,
      stop(
        "Generic send / sit rotation stays ~14 days (D43). D50 is the live-send warmup clock only.",
        `Generic send rest is now ${defaults.genericSendRestDays} days.`,
      ),
    );
  });
});

describe("owner intent — D51 kill-only pull", () => {
  it("D51: no placement/bounce pulls; copy canaries stay on campaign copy", () => {
    for (const knob of [
      "enableBounceRotation",
      "enableLegacyMailboxPulls",
      "enableRemediation",
      "enableRecoveryPool",
    ]) {
      assert.ok(
        !(knob in defaults),
        stop(
          "The pull/rotation machinery is deleted, not gated (D51/D130).",
          `config grew ${knob} back — is the old engine returning?`,
        ),
      );
    }
    assert.equal(
      defaults.enableCopyCanary,
      true,
      stop(
        "Purposely unwarmed boxes send campaign copy (D51).",
        "ENABLE_COPY_CANARY now defaults off.",
      ),
    );
    assert.equal(
      defaults.copyCanaryPerCampaign,
      3,
      stop(
        "Each live campaign keeps 3 unwarmed campaign-copy canaries (D51).",
        `Copy canaries per campaign is now ${defaults.copyCanaryPerCampaign}.`,
      ),
    );
    assert.equal(
      "canaryCampaignDays" in defaults,
      false,
      stop(
        "Launch canary is still not in this loop (D43). Copy canaries are a different thing.",
        "canaryCampaignDays came back.",
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

describe("owner intent — D63 shorts are not a generic shortage", () => {
  it("D63: Slack does not blame missing spares; leftover campaign ids are not excluded", async () => {
    const { staffingSlackLines } = await import("../lib/staffingSlack.js");
    const text = staffingSlackLines({
      stillShort: [
        {
          name: "BCP PE Firms (No Team)",
          staffable: 22,
          shortBy: 22,
          status: "ACTIVE",
        },
      ],
    }).join("\n");
    assert.match(
      text,
      /Spare inboxes are not the shortage/,
      stop(
        "Thin client campaigns are missing that client's own inboxes (D63).",
        "Staffing Slack no longer says spare inboxes are not the shortage.",
      ),
    );
    assert.equal(
      /not enough warmed spares/i.test(text),
      false,
      stop(
        "Do not tell Josh we are short of warmed spares (D63).",
        "Staffing Slack blames a generic shortage again.",
      ),
    );
    const { readFile } = await import("node:fs/promises");
    const health = await readFile(
      new URL("../services/campaignHealth.ts", import.meta.url),
      "utf8",
    );
    assert.equal(
      /not enough warmed spares/i.test(health),
      false,
      stop(
        "Health Slack must not say we lack warmed spares (D63).",
        "campaignHealth.ts still blames a generic shortage.",
      ),
    );
    const { isExcludedOnlyMembership } = await import(
      "../services/clientRest.js"
    );
    assert.equal(
      isExcludedOnlyMembership([9999], new Map([[1, { id: 1, name: "Live" }]]), [
        "msrs",
      ]),
      false,
      stop(
        "A leftover campaign id is not an exclusion (D63).",
        "isExcludedOnlyMembership now skips inboxes that only have ghost campaign ids.",
      ),
    );
  });
});

describe("owner intent — D64 staffing Slack is end of day", () => {
  it("D64: health does not Slack a still-short-only pass", async () => {
    const { readFile } = await import("node:fs/promises");
    const health = await readFile(
      new URL("../services/campaignHealth.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      health,
      /stillShort: \[\]/,
      stop(
        "Health Slack on the 15-minute loop is actions only (D64).",
        "campaignHealth.ts still Slacks the still-short list mid-day.",
      ),
    );
    assert.match(
      health,
      /if \(!action\) return/,
      stop(
        "A still-short-only health pass stays quiet (D64).",
        "Health still Slacks when it did not move anything.",
      ),
    );
    const brief = await readFile(
      new URL("../services/clientDayBrief.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      brief,
      /endOfDay/,
      stop(
        "The client day brief posts staffing at end of day (D64).",
        "clientDayBrief.ts no longer takes an end-of-day staffing pass.",
      ),
    );
  });
});

describe("owner intent — D69 copy Slack is the word and a one-click edit", () => {
  it("D69: do not Slack a copy guess; Slack the word and Make the changes", async () => {
    // The old rotation engine (and its copy-guess Slack) is deleted (D130).
    // Copy suspects now come from the daily delivery watch, which feeds the
    // D93/D96 verdict instead of guessing in Slack.
    const watch = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/deliveryWatch.ts", import.meta.url), "utf8"),
    );
    assert.match(
      watch,
      /markCopySuspect/,
      stop(
        "Copy suspects still start the canary + word hunt (D69).",
        "deliveryWatch.ts no longer marks copy suspects.",
      ),
    );
    // The paused-bounce hunt (and its copy-guess Slack) was deleted outright
    // (D91/D129) — nothing left to check there.
    const { copySwapProof } = await import("../lib/isolationProof.js");
    const proof = copySwapProof({
      campaignName: "BCP Healthcare Over-1k (No Team)",
      element: "free",
      swap: "complimentary",
      controlLanded: true,
    });
    assert.match(
      proof,
      /It was the word \*free\*/,
      stop(
        "The Slack names the word (D69).",
        "copySwapProof no longer says it was this word.",
      ),
    );
    assert.match(
      proof,
      /Make the changes\?/,
      stop(
        "The Slack asks to make the changes (D69).",
        "copySwapProof no longer asks Make the changes?",
      ),
    );
  });
});

describe("owner intent — D65 retired domains stay off", () => {
  it("D65: fan-out, rest, and top-up skip retired sending domains", async () => {
    const { readFile } = await import("node:fs/promises");
    const { isRetiredSendingDomain } = await import("../lib/domainControl.js");
    assert.equal(
      isRetiredSendingDomain("hubmeetconnect.com", { status: "retired" }),
      true,
      stop(
        "A retired domain stays off live campaigns (D65).",
        "isRetiredSendingDomain no longer treats status=retired as off-limits.",
      ),
    );
    const fanout = await readFile(
      new URL("../services/clientFanOut.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      fanout,
      /isRetiredSendingDomain/,
      stop(
        "Fan-out must not put retired-domain inboxes back on campaigns (D65).",
        "clientFanOut.ts no longer checks isRetiredSendingDomain.",
      ),
    );
    const rest = await readFile(
      new URL("../services/clientRest.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      rest,
      /isRetiredSendingDomain/,
      stop(
        "Rest restore must not put retired-domain inboxes back (D65).",
        "clientRest.ts no longer checks isRetiredSendingDomain.",
      ),
    );
    const topUp = await readFile(
      new URL("../services/campaignTopUp.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      topUp,
      /isRetiredSendingDomain/,
      stop(
        "Top-up must not staff from a retired domain (D65).",
        "campaignTopUp.ts no longer checks isRetiredSendingDomain.",
      ),
    );
  });
});

describe("owner intent — D60 canary buy once", () => {
  it("D60: do not ask again after the fleet is bought or waiting", async () => {
    const { canaryFleetBuyAlreadyOpen } = await import(
      "../lib/copyCanaryFleet.js"
    );
    assert.equal(
      canaryFleetBuyAlreadyOpen(
        { status: "awaiting_mailboxes", domains: ["a.info"], emails: [], updatedAt: "" },
        [],
      ),
      true,
      stop(
        "A bought canary fleet waiting on mailboxes is not a new ask (D60).",
        "Empty emails now look like the fleet was never bought.",
      ),
    );
    assert.equal(
      canaryFleetBuyAlreadyOpen(null, [
        { kind: "buy_canary_fleet", status: "executed" },
      ]),
      true,
      stop(
        "An executed canary buy blocks a second Slack prompt (D60).",
        "Executed canary buys can be asked again.",
      ),
    );
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../services/copyCanary.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      src,
      /reconcileFleetPurchase|shouldSkipFleetBuy/,
      stop(
        "Health restores the bought fleet and does not ask again (D60).",
        "copyCanary.ts no longer skips a second canary-fleet ask.",
      ),
    );
  });
});

describe("owner intent — D54 dedicated canary fleet", () => {
  it("D54: two domains, three inboxes each, Google + Outlook, warmup off, Josh-only spend", async () => {
    const { COPY_CANARY_FLEET_DOMAIN_COUNT, COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN } =
      await import("../lib/copyCanaryFleet.js");
    assert.equal(
      COPY_CANARY_FLEET_DOMAIN_COUNT,
      2,
      stop(
        "The canary fleet is two new domains (D54).",
        `Domain count is now ${COPY_CANARY_FLEET_DOMAIN_COUNT}.`,
      ),
    );
    assert.equal(
      COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN,
      3,
      stop(
        "Each canary domain gets three inboxes (D54).",
        `Mailboxes per domain is now ${COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN}.`,
      ),
    );
    const { canDecideIsolationAction } = await import(
      "../lib/isolationActors.js"
    );
    assert.equal(
      canDecideIsolationAction("buy_canary_fleet", "operator"),
      false,
      stop(
        "Only Josh can approve buying the canary fleet (D4/D54).",
        "Cayden can now approve the canary fleet purchase.",
      ),
    );
    assert.equal(
      defaults.requireSpendApproval,
      true,
      stop(
        "Canary fleet spend still goes through the approval ledger (D4/D54).",
        "Spend approval now defaults off.",
      ),
    );
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../services/copyCanary.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      src,
      /getCopyCanaryFleet/,
      stop(
        "Copy canaries come from the dedicated fleet (D54).",
        "copyCanary.ts no longer reads the dedicated fleet.",
      ),
    );
    assert.doesNotMatch(
      src,
      /status !== "warming"/,
      stop(
        "Do not pick still-warming pool generics as canaries (D54).",
        "copyCanary.ts is attaching warming-pool mailboxes again.",
      ),
    );
  });
});

describe("owner intent — D83 canary warmup stays off on the 15m pass", () => {
  it("D83: the health gap pass turns canary-fleet warmup off", async () => {
    const { readFile } = await import("node:fs/promises");
    const settings = await readFile(
      new URL("../services/mailboxSettings.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      settings,
      /needsWarmupOff/,
      stop(
        "Mailbox settings turns canary warmup off (D83).",
        "mailboxSettings.ts no longer disables canary warmup.",
      ),
    );
    assert.match(
      settings,
      /warmup_enabled: false/,
      stop(
        "Canary warmup writes false, not true (D83).",
        "mailboxSettings.ts no longer writes warmup_enabled false.",
      ),
    );
    const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(
      index,
      /D83/,
      stop(
        "The 15-minute health loop is where canary warmup-off lives (D83).",
        "index.ts no longer mentions D83 on the health gap pass.",
      ),
    );
  });
});

describe("owner intent — D55 canaries off campaigns", () => {
  it("D55: canaries send campaign copy in tests and never join a campaign", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../services/copyCanary.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      src,
      /addEmailAccountsToCampaign/,
      stop(
        "Canaries stay off live campaigns (D55).",
        "copyCanary.ts is adding canaries to campaigns again.",
      ),
    );
    assert.match(
      src,
      /removeEmailAccountsFromCampaign/,
      stop(
        "A canary already on a campaign gets pulled off (D55).",
        "copyCanary.ts no longer detaches canaries from campaigns.",
      ),
    );
    assert.match(
      src,
      /canaryCopyTestName|createAutomatedPlacement/,
      stop(
        "Canaries run campaign copy as placement tests (D55).",
        "copyCanary.ts no longer schedules a canary-copy test.",
      ),
    );
  });
});

describe("owner intent — D56 paused pod-control shell", () => {
  it("D56: known-good tests hang on a paused shell, never a live campaign", async () => {
    const { isPodControlShellCampaign, POD_CONTROL_SHELL_NAME } = await import(
      "../lib/podControlShell.js"
    );
    assert.equal(
      isPodControlShellCampaign({ id: 1, name: POD_CONTROL_SHELL_NAME }),
      true,
      stop(
        "The paused shell is identified by name (D56).",
        "isPodControlShellCampaign no longer matches Pod control shell.",
      ),
    );
    assert.equal(
      isExcluded({ id: 99, name: POD_CONTROL_SHELL_NAME }, []),
      true,
      stop(
        "Health / top-up / fan-out never staff the shell (D56).",
        "isExcluded no longer always excludes the pod-control shell.",
      ),
    );

    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../services/podControls.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      src,
      /ensurePodControlShell/,
      stop(
        "Pod controls create or reuse the paused shell (D56).",
        "podControls.ts no longer calls ensurePodControlShell.",
      ),
    );
    assert.doesNotMatch(
      src,
      /status === "ACTIVE"\)\?\.id/,
      stop(
        "Do not hang pod controls on the first ACTIVE campaign (D56).",
        "podControls.ts fell back to a live campaign as the shell.",
      ),
    );
    assert.match(
      src,
      /delete \(scheduled as \{ sequence\?: unknown \}\)\.sequence/,
      stop(
        "Schedule payload omits a custom sequence; the shell is the email (D56).",
        "podControls.ts still sends a custom sequence on /spam-test/schedule.",
      ),
    );
  });
});

describe("owner intent — D58 half-client floor", () => {
  it("D58/D82: floor is half the client's inboxes; no named-client exception", async () => {
    const { clientInboxStaffFloor, staffFloorForCampaign } = await import(
      "../lib/clientStaffFloor.js"
    );
    assert.equal(
      clientInboxStaffFloor(80),
      40,
      stop(
        "80 client inboxes mean a 40-sender floor (D58).",
        `Half-inbox floor is now ${clientInboxStaffFloor(80)}.`,
      ),
    );
    assert.equal(
      staffFloorForCampaign(
        { client_id: 9, name: "Vasco - Service" },
        new Map([["id:9", 40]]),
        "Vasco Warranty",
      ),
      20,
      stop(
        "Vasco uses the same half-floor as everyone else (D82).",
        "staffFloorForCampaign still special-cases Vasco.",
      ),
    );

    const { readFile } = await import("node:fs/promises");
    const topUp = await readFile(
      new URL("../services/campaignTopUp.ts", import.meta.url),
      "utf8",
    );
    const fanOut = await readFile(
      new URL("../services/clientFanOut.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      topUp,
      /campaignMayTakeGenerics/,
      stop(
        "Top-up uses POC or Slack approve for generics (D81/D82).",
        "campaignTopUp.ts no longer uses campaignMayTakeGenerics.",
      ),
    );
    assert.match(
      topUp,
      /client-inbox only/,
      stop(
        "Top-up will not restaff unapproved campaigns with generics (D82).",
        "campaignTopUp.ts assigns generics without the POC/Slack gate.",
      ),
    );
    assert.match(
      fanOut,
      /campaignMayTakeGenerics/,
      stop(
        "Fan-out uses the same POC or Slack-approve rule (D82).",
        "clientFanOut.ts still special-cases Goliath generics.",
      ),
    );
  });
});

describe("owner intent — D59 clean slate", () => {
  it("D59: leftover unhealthy marks do not keep a B-pod box off", async () => {
    const { readFile, access } = await import("node:fs/promises");
    // The one-shot wipe ran 2026-08-24 and was deleted (D129).
    await assert.rejects(
      access(new URL("../services/unhealthyReset.ts", import.meta.url)),
      stop(
        "The unhealthy wipe ran once; its code is gone (D59/D129).",
        "unhealthyReset.ts exists again.",
      ),
    );
    const rest = await readFile(
      new URL("../services/clientRest.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      rest,
      /shouldVetoRestRestore|lastSameEspInbox\s*<|veto same-ESP/,
      stop(
        "Old same-ESP scores never veto a rest restore (D59/D129).",
        "clientRest.ts vetoes restores on leftover placement scores again.",
      ),
    );
    assert.match(
      rest,
      /onWeekTargets/,
      stop(
        "On-week client inboxes go on every live campaign for that client (D59).",
        "clientRest.ts no longer restaffs the full on-week pod.",
      ),
    );
  });
});

describe("owner intent — D52 lead runout", () => {
  it("D52: watch remaining leads; never import; do not reuse campaign audit", async () => {
    assert.equal(
      defaults.enableLeadRunout,
      true,
      stop(
        "Tell Josh when a live campaign is running out of leads (D52).",
        "ENABLE_LEAD_RUNOUT now defaults off.",
      ),
    );
    const { formatRunoutMessage } = await import("../lib/leadRunout.js");
    const text = formatRunoutMessage({
      campaignName: "Parlay A",
      stage: "half",
      remaining: 400,
      sentPerDay: 100,
      performance: "working",
    });
    assert.match(
      text,
      /have not imported/i,
      stop(
        "Lead runout tells Josh and waits. It never imports (D52).",
        "The Slack copy no longer says we have not imported.",
      ),
    );
    const { readFileSync } = await import("node:fs");
    const runout = readFileSync(new URL("../services/leadRunout.ts", import.meta.url), "utf8");
    const audit = readFileSync(new URL("../services/campaignAudit.ts", import.meta.url), "utf8");
    assert.doesNotMatch(
      runout,
      /addLeads|importLeads|uploadLeads/i,
      stop(
        "Lead runout must not import leads (D52).",
        "leadRunout.ts now writes leads.",
      ),
    );
    assert.doesNotMatch(
      audit,
      /total_leads|notStarted|lead_stats/i,
      stop(
        "Campaign audit watches senders, not remaining leads (D52).",
        "campaignAudit.ts now watches the same lead number.",
      ),
    );
  });
});

describe("owner intent — D53 sending infra", () => {
  it("D53: census sending IPs from placement reports; do not spend", async () => {
    assert.equal(
      defaults.enableSendingInfraCensus,
      true,
      stop(
        "Read sending IPs from placement reports before any add-on (D53).",
        "ENABLE_SENDING_INFRA_CENSUS now defaults off.",
      ),
    );
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../services/sendingInfra.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /spendGateway|purchase|porkbun|inboxkit/i,
      stop(
        "The infra census must not spend (D53).",
        "sendingInfra.ts now touches spend or a vendor buy.",
      ),
    );
    const { formatInfraMessage, summarizeSendingInfra } = await import(
      "../lib/sendingInfra.js"
    );
    const good = formatInfraMessage(
      summarizeSendingInfra([
        {
          ip: "142.250.1.1",
          domain: "crosslaunchco.com",
          country: "United States",
          owner: "Google LLC",
          regionOk: true,
          listed: false,
          listNames: [],
          reputableEsp: true,
        },
      ]),
    );
    assert.match(good, /would buy us nothing/);
    assert.doesNotMatch(good, /D\d+/);
  });
});

describe("owner intent — D71 Slack is deliverability flags plus EOD", () => {
  it("D71: Slack allowlist is burned domain, isolated word, EOD, button result", async () => {
    const { slackAllowed, slackKindForIsolationAction } = await import(
      "../lib/slackAllow.js"
    );
    assert.equal(
      slackAllowed(),
      false,
      stop(
        "Unclassified Slack stays in the log (D71).",
        "slackAllowed() is now true with no kind.",
      ),
    );
    assert.equal(
      slackAllowed("eod_summary"),
      true,
      stop(
        "The end-of-day send/spam scoreboard still Slacks (D71).",
        "eod_summary is no longer allowed.",
      ),
    );
    assert.equal(
      slackKindForIsolationAction("retire_domain"),
      "burned_domain",
      stop(
        "A burned domain still Slacks the retire / replace button (D71).",
        "retire_domain is no longer a Slack allow kind.",
      ),
    );
    assert.equal(
      slackKindForIsolationAction("swap_copy"),
      "copy_word",
      stop(
        "An isolated word still Slacks Make the changes (D71).",
        "swap_copy is no longer a Slack allow kind.",
      ),
    );
    assert.equal(
      slackAllowed("generic_backfill"),
      true,
      stop(
        "Josh Slack-approves generic backfill (D81).",
        "generic_backfill is not a Slack allow kind.",
      ),
    );
    assert.equal(
      slackKindForIsolationAction("buy_canary_fleet"),
      null,
      stop(
        "Canary-fleet buy asks stay off Slack (D71).",
        "buy_canary_fleet is Slack-allowed again.",
      ),
    );

    const rest = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/clientRest.ts", import.meta.url), "utf8"),
    );
    assert.equal(
      /This fortnight, group/.test(rest),
      false,
      stop(
        "Do not Slack who is on this fortnight (D71).",
        "clientRest.ts still composes the pod/cohort Slack.",
      ),
    );
    const brief = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../clients/slack.ts", import.meta.url), "utf8"),
    );
    assert.equal(
      /Staffing \(end of day\)/.test(brief),
      false,
      stop(
        "The EOD Slack is sends and spam, not staffing (D71).",
        "slack.ts still Slacks the staffing picture.",
      ),
    );
    assert.match(
      brief,
      /eod_summary/,
      stop(
        "The EOD scoreboard still has an allow kind (D71).",
        "slack.ts no longer posts eod_summary.",
      ),
    );
  });
});

describe("owner intent — D74 QA catches a foreign-client signature", () => {
  it("D74: a leftover other-client brand is not a valid signature", async () => {
    const { desiredMailboxSignature } = await import(
      "../lib/mailboxSignature.js"
    );
    const { findForeignBrand } = await import("../lib/clientBrand.js");
    assert.equal(
      desiredMailboxSignature({
        fromName: "Aarav Sanchez",
        signature: "Aarav Sanchez\nRoofs by Peterson",
        clientBrand: "Goliath Cybersecurity",
        otherClientBrands: ["Roofs by Peterson", "Goliath Cybersecurity"],
      }),
      "Aarav Sanchez\nGoliath Cybersecurity",
      stop(
        "A Peterson leftover on a Goliath mailbox is rewritten (D74).",
        "desiredMailboxSignature still preserves a foreign brand line.",
      ),
    );
    assert.equal(
      findForeignBrand(
        "Aarav Sanchez\nRoofs by Peterson",
        "Goliath Cybersecurity",
        ["Roofs by Peterson", "Goliath Cybersecurity"],
      ),
      "Roofs by Peterson",
      stop(
        "QA must see Roofs by Peterson on a Goliath send (D74).",
        "findForeignBrand no longer matches Peterson on Goliath hay.",
      ),
    );

    const audit = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/campaignAudit.ts", import.meta.url), "utf8"),
    );
    assert.match(
      audit,
      /SIG-MISMATCH/,
      stop(
        "Campaign audit is the signature QA scan (D74).",
        "campaignAudit.ts no longer logs SIG-MISMATCH.",
      ),
    );
    const settings = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/mailboxSettings.ts", import.meta.url), "utf8"),
    );
    assert.match(
      settings,
      /foreign-brand sigs/,
      stop(
        "Health rewrites a foreign signature on the gap pass (D74).",
        "mailboxSettings.ts no longer rewrites foreign brands in gap mode.",
      ),
    );
  });
});

describe("owner intent — D75 one inbox one client", () => {
  it("D75: foreign campaign memberships are pulled every health pass", async () => {
    const { foreignCampaignIds, ownerClientId } = await import(
      "../lib/oneClient.js"
    );
    assert.deepEqual(
      foreignCampaignIds(548611, [
        { campaignId: 1, clientId: 548611, shell: false },
        { campaignId: 2, clientId: 99, shell: false },
        { campaignId: 9, clientId: 99, shell: true },
      ]),
      [2],
      stop(
        "An inbox may not sit on another client's campaign (D75).",
        "foreignCampaignIds no longer pulls the Peterson campaign.",
      ),
    );
    assert.equal(
      ownerClientId(548611, [
        { campaignId: 2, clientId: 99, shell: false },
      ]),
      548611,
      stop(
        "Mailbox client_id is the owner (D75).",
        "ownerClientId no longer trusts mailbox.client_id.",
      ),
    );
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../services/oneClientMembership.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.match(
      src,
      /removeEmailAccountsFromCampaign/,
      stop(
        "Health pulls the foreign membership (D75).",
        "oneClientMembership.ts no longer removes cross-client campaigns.",
      ),
    );
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /oneClientMembership\.run/,
      stop(
        "The 15-minute health loop runs the one-client cleanup (D75).",
        "index.ts no longer calls oneClientMembership.run.",
      ),
    );
  });
});

describe("owner intent — D76 generics belong to Goliath", () => {
  it("D76: a leftover Peterson client_id does not own a pool generic", async () => {
    const { ownerClientId } = await import("../lib/oneClient.js");
    assert.equal(
      ownerClientId(
        548610,
        [{ campaignId: 2, clientId: 548610, shell: false }],
        { generic: true, genericOwnerId: 548611 },
      ),
      548611,
      stop(
        "Pool generics belong to Goliath even with a leftover client_id (D76).",
        "ownerClientId still treats mailbox.client_id as owner for generics.",
      ),
    );
    const { isGenericMailbox } = await import("../lib/clientInbox.js");
    assert.equal(
      isGenericMailbox(
        { client_id: 548610, from_name: "Aarav Sanchez" },
        "aaravsanchez@getoutreachdesk.info",
        { extraGenericMailboxes: [], extraGenericDomains: [] },
        { getPoolMailbox: () => undefined },
      ),
      true,
      stop(
        "Pool-plan domains are generic without the local pool file (D76).",
        "getoutreachdesk.info is no longer treated as a generic.",
      ),
    );
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../services/oneClientMembership.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.match(
      src,
      /addEmailAccountsToCampaign/,
      stop(
        "A stranded generic is put back on ACTIVE Goliath campaigns (D76).",
        "oneClientMembership.ts no longer restores generics onto Goliath.",
      ),
    );
    assert.match(
      src,
      /genericOwnerId/,
      stop(
        "Health uses Goliath as the generic owner (D76).",
        "oneClientMembership.ts no longer passes genericOwnerId.",
      ),
    );
  });
});

describe("owner intent — D77 client tag and QA unpause", () => {
  it("D77: campaigns get a client tag; Goliath unpauses only after sigs match", async () => {
    const { matchClientForCampaign } = await import("../lib/campaignClient.js");
    assert.equal(
      matchClientForCampaign("Goliath Displacement M", [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 99, name: "Peterson", logo: "Roofs by Peterson" },
      ])?.id,
      548611,
      stop(
        "A campaign name maps to exactly one client tag (D77).",
        "matchClientForCampaign no longer assigns Goliath.",
      ),
    );
    const tagSrc = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../services/campaignClientTag.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.match(
      tagSrc,
      /setCampaignClientId/,
      stop(
        "Health writes the campaign client tag (D77).",
        "campaignClientTag.ts no longer assigns client_id.",
      ),
    );
    const unpause = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../services/unpauseAfterSigQa.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.match(
      unpause,
      /updateCampaignStatus\(campaign\.id, "START"\)/,
      stop(
        "A passing signature QA STARTs the paused Goliath campaign (D77).",
        "unpauseAfterSigQa.ts no longer STARTs after a clean QA.",
      ),
    );
    assert.match(
      unpause,
      /isAnyShellCampaign|isPodControlShellCampaign/,
      stop(
        "The pod-control shell stays paused (D56 / D77).",
        "unpauseAfterSigQa.ts no longer skips the shell.",
      ),
    );
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /unpauseAfterSigQa\.run/,
      stop(
        "The 15-minute health loop unpauses after signature QA (D77).",
        "index.ts no longer calls unpauseAfterSigQa.run.",
      ),
    );
  });
});

describe("owner intent — D80 campaign bounce autostop", () => {
  it("D80/D88/D90: the 10-minute loop is the only bounce actor; Smartlead stays off", async () => {
    // The 20/7 bands are retired (D88); the live trips are D90's and are
    // guarded there. This guard keeps the loop itself and the off-write.
    assert.equal(
      defaults.enableCampaignBounceAutostop,
      true,
      stop(
        "Our campaign bounce autostop stays on (D80).",
        "ENABLE_CAMPAIGN_BOUNCE_AUTOSTOP now defaults off.",
      ),
    );
    assert.equal(
      defaults.cronBounceAutostop,
      "*/10 * * * *",
      stop(
        "Bounce autostop polls every 10 minutes (D80).",
        `Cron is now ${defaults.cronBounceAutostop}.`,
      ),
    );
    assert.equal(
      defaults.smartleadBounceAutopauseOffPercent,
      100,
      stop(
        "Smartlead bounce autopause stays off at 100 (D80).",
        `Off percent is now ${defaults.smartleadBounceAutopauseOffPercent}.`,
      ),
    );
    const bounceLib = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/bounceAutopause.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(
      bounceLib,
      /isUnder1kCampaign|isOver1kCampaign|isGoliathCampaign/,
      stop(
        "Campaign names never pick a bounce threshold (D80/D88/D129).",
        "bounceAutopause.ts grew name-band helpers again.",
      ),
    );
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /campaignBounceAutostop\.run/,
      stop(
        "The 10-minute loop runs our bounce autostop (D80).",
        "index.ts no longer calls campaignBounceAutostop.run.",
      ),
    );
    assert.doesNotMatch(
      index,
      /if \(config\.enableBounceAutopauseConverge\) \{\s*await bounceAutopause\.run/,
      stop(
        "Health must not converge Smartlead autopause on (D80).",
        "Health still calls bounceAutopause.run as the live bounce rule.",
      ),
    );
  });
});

describe("owner intent — D81 new-campaign audit + hourly sweep", () => {
  it("D81: first-seen check is on; hourly cron is on the hour; Goliath is POC; no bounce pause", async () => {
    assert.equal(
      defaults.enableCampaignCheck,
      true,
      stop(
        "New campaigns are first-checked, then swept hourly (D81).",
        "ENABLE_CAMPAIGN_CHECK now defaults off.",
      ),
    );
    assert.equal(
      defaults.cronCampaignCheck,
      "0 * * * *",
      stop(
        "Campaign sweeps run every hour (D81).",
        `Campaign-check cron is now ${defaults.cronCampaignCheck}.`,
      ),
    );
    assert.deepEqual(
      defaults.pocClientNamePatterns,
      ["goliath"],
      stop(
        "Goliath is the POC client (D81).",
        `POC patterns are now ${defaults.pocClientNamePatterns.join(",")}.`,
      ),
    );
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /campaignCheck\.run\(\{\s*mode:\s*"first"/,
      stop(
        "Health first-checks a newly seen campaign (D81).",
        "index.ts no longer calls campaignCheck.run first mode.",
      ),
    );
    const check = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/campaignCheck.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(
      check,
      /updateCampaignStatus\([^)]*START/,
      stop(
        "The campaign checker never STARTs a campaign (D40/D81).",
        "campaignCheck.ts now STARTs campaigns.",
      ),
    );
    // D131 — the one status write the checker may make: converging a
    // non-paused instrumentation shell back to PAUSED (D56/D114/D85).
    const statusWrites = check.match(/updateCampaignStatus\([^)]*\)/g) ?? [];
    assert.ok(
      statusWrites.every((call) => call.includes('"PAUSED"')),
      stop(
        "The checker's only status write is pausing a shell (D131).",
        `campaignCheck.ts writes campaign status beyond the shell pause: ${statusWrites.join(", ")}`,
      ),
    );
    assert.doesNotMatch(
      check,
      /bounce_autopause|desiredBounceAutopausePercent|getCampaignSettings/,
      stop(
        "This checker does not read Smartlead bounce auto-pause (D81 / Cayden D80).",
        "campaignCheck.ts still watches bounce_autopause_threshold.",
      ),
    );
    assert.doesNotMatch(
      check,
      /generic_on_non_goliath|allowsGenericStaff/,
      stop(
        "Generics are POC or Slack-approved, not a Goliath-only name list (D81).",
        "campaignCheck.ts still special-cases Goliath generics.",
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

describe("owner intent — D82 one rule for every client", () => {
  it("D82: no Vasco exception; POC/Slack generics; two canary checks; shell is not a hide", async () => {
    // FULL_SEND_CLIENT_PATTERNS was deleted outright (D129): nobody skips
    // A/B rest or takes a full-count floor, and there is no knob to bring
    // that back without a code change.
    const { CAMPAIGN_CHECK_KINDS, isFirstCheckBlocking } = await import(
      "../lib/campaignCheck.js"
    );
    assert.ok(
      CAMPAIGN_CHECK_KINDS.includes("inbox_missing_known_good"),
      stop(
        "Hourly check requires each serving inbox on a known-good canary (D82).",
        "inbox_missing_known_good is gone from campaign checks.",
      ),
    );
    assert.equal(
      isFirstCheckBlocking("inbox_missing_known_good"),
      false,
      stop(
        "Missing known-good canaries do not fail the first-check (D81/D82).",
        "inbox_missing_known_good now blocks first-check.",
      ),
    );
    const { isExcludedOnlyMembership } = await import(
      "../services/clientRest.js"
    );
    assert.equal(
      isExcludedOnlyMembership(
        [3841904],
        new Map([[3841904, { id: 3841904, name: "Pod control shell" }]]),
        [],
      ),
      false,
      stop(
        "An inbox only on the paused shell is still in the rest loop (D72/D82).",
        "isExcludedOnlyMembership still treats the shell as excluded-only.",
      ),
    );
    const unpause = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../services/unpauseAfterSigQa.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.match(
      unpause,
      /isPocClient/,
      stop(
        "QA unpause is any POC, not the word Goliath (D82).",
        "unpauseAfterSigQa.ts still gates on Goliath by name.",
      ),
    );
    const check = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../services/campaignCheck.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.match(
      check,
      /livingKnownGoodEmails/,
      stop(
        "Campaign check reads living known-good canary coverage (D82).",
        "campaignCheck.ts no longer checks per-inbox known-good canaries.",
      ),
    );
    assert.match(
      check,
      /hasLivingUnwarmedCopyCanary/,
      stop(
        "Campaign check requires the unwarmed campaign-copy canary (D82).",
        "campaignCheck.ts no longer checks the unwarmed copy canary.",
      ),
    );
  });
});

describe("owner intent — D84 canon sweep", () => {
  it("D84: one inventory per pass; fan-out staffs detached client inboxes; drift-only converge; watchdog", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    const index = await read("../index.ts");
    assert.match(
      index,
      /stage\("inventory", \(\) => inventoryBook\.fetchFresh\(\)\)/,
      stop(
        "The health pass fetches Smartlead inventory once through the shared book and shares it (D84/D132).",
        "index.ts no longer builds one shared inventory per pass.",
      ),
    );
    assert.match(
      index,
      /recordStageOk|stageHealth/,
      stop(
        "Every health stage records success/failure for the watchdog (D84).",
        "index.ts no longer records stage health.",
      ),
    );
    assert.match(
      index,
      /canonFindings/,
      stop(
        "/health exposes the canon scoreboard (D84).",
        "index.ts no longer reports canonFindings.",
      ),
    );
    assert.match(
      index,
      /canonFindingSamples/,
      stop(
        "/health names the campaigns behind each canon hole (D98).",
        "index.ts reports counts only — a 46-wide hole cannot be read.",
      ),
    );

    const fanOut = await read("../services/clientFanOut.ts");
    assert.doesNotMatch(
      fanOut,
      /if \(!touchesGroup && !isBcpInventory\) continue/,
      stop(
        "A detached client inbox is still fanned onto its client's campaigns (D84).",
        "clientFanOut.ts regained the touches-the-group gate for client inboxes — this is what left TechEvo and Peterson at 1 sender.",
      ),
    );
    assert.match(
      fanOut,
      /if \(generic && !touchesGroup && !isBcpInventory\) continue/,
      stop(
        "Idle generics stay top-up supply, not fan-out supply (D84).",
        "clientFanOut.ts no longer gates idle generics out of fan-out.",
      ),
    );
    assert.doesNotMatch(
      fanOut,
      /groupCampaigns\.length < 2/,
      stop(
        "A single-campaign client still gets fan-out staffing (D84).",
        "clientFanOut.ts skips single-campaign groups again.",
      ),
    );

    const autostop = await read("../services/campaignBounceAutostop.ts");
    assert.match(
      autostop,
      /isTerminalCampaignStatus/,
      stop(
        "COMPLETED/STOPPED campaigns are never converged (D84).",
        "campaignBounceAutostop.ts writes terminal campaigns again.",
      ),
    );
    assert.match(
      autostop,
      /getAutopauseOffAt/,
      stop(
        "Bounce autopause converge is write-on-drift, not ~600 writes/hour (D84).",
        "campaignBounceAutostop.ts lost the converged-campaign cache.",
      ),
    );

    const check = await read("../services/campaignCheck.ts");
    assert.match(
      check,
      /removeCampaignCheck/,
      stop(
        "Terminal campaigns leave the sweep and the scoreboard (D84).",
        "campaignCheck.ts keeps stale findings for COMPLETED/STOPPED campaigns.",
      ),
    );
    assert.match(
      check,
      /FIRST_CHECK_RETRY_MS/,
      stop(
        "A blocked first-check backs off to hourly re-inspection (D84).",
        "campaignCheck.ts re-reads sequences for blocked campaigns every 15 minutes again.",
      ),
    );
  });
});

describe("owner intent — D85 findings have owners", () => {
  it("D85: signature one-tap fixer; untagged escalation; one fleet fact; one bounce writer", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    // The fixer is append-only: original copy survives verbatim, subjects
    // are never touched, tagged bodies are left byte-for-byte.
    const { appendSignatureTag } = await import("../lib/signatureQa.js");
    const body = "<p>Sean, that offer's still open</p>";
    const fixed = appendSignatureTag([
      { id: 1, seq_number: 1, subject: "hey", email_body: body },
      {
        id: 2,
        seq_number: 2,
        subject: "hey",
        email_body: "<p>open?</p><p>%signature%</p>",
      },
    ]);
    assert.equal(
      fixed.sequences[0]?.email_body,
      `${body}<br><br>%signature%`,
      stop(
        "The signature fixer appends the tag and nothing else (D85).",
        "appendSignatureTag no longer preserves the original body verbatim.",
      ),
    );
    assert.equal(
      fixed.sequences[1]?.email_body,
      "<p>open?</p><p>%signature%</p>",
      stop(
        "A body that already has %signature% is untouched (D85).",
        "appendSignatureTag rewrote an already-tagged body.",
      ),
    );
    assert.equal(
      fixed.sequences[0]?.subject,
      "hey",
      stop(
        "The signature fixer never edits subjects (D85).",
        "appendSignatureTag changed a subject line.",
      ),
    );

    const check = await read("../services/campaignCheck.ts");
    assert.match(
      check,
      /autoApplySignature/,
      stop(
        "missing signature is written automatically (D92).",
        "campaignCheck.ts no longer auto-applies the signature.",
      ),
    );
    assert.match(
      check,
      /setCanaryFleetDown/,
      stop(
        "A dead canary fleet is one fleet-level fact, not a finding per campaign (D85).",
        "campaignCheck.ts no longer records canaryFleetDown.",
      ),
    );

    const index = await read("../index.ts");
    assert.doesNotMatch(
      index,
      /services\/bounceAutopause/,
      stop(
        "One Smartlead autopause writer: the autostop loop (D80/D84/D85).",
        "index.ts wires the standalone BounceAutopauseService again — two blind writers is how the key starved into 429s.",
      ),
    );
    assert.match(
      index,
      /canaryFleetDown/,
      stop(
        "/health exposes the fleet-down fact (D85).",
        "index.ts no longer reports canaryFleetDown.",
      ),
    );

    // Untagged campaigns are escalated on the EOD brief, never guessed (D77).
    const brief = await read("../services/clientDayBrief.ts");
    assert.match(
      brief,
      /untaggedCampaigns/,
      stop(
        "Campaigns the tagger cannot match are named on the EOD brief (D85).",
        "clientDayBrief.ts dropped the untagged-campaign escalation — they go back to silent QA jail.",
      ),
    );
    const slackSrc = await read("../clients/slack.ts");
    assert.match(
      slackSrc,
      /untaggedCampaigns/,
      stop(
        "The EOD brief renders the untagged-campaign list (D85).",
        "slack.ts accepts untaggedCampaigns but never renders it.",
      ),
    );
    assert.match(
      slackSrc,
      /staffingShorts ?\?\? \[\]/,
      stop(
        "The EOD staffing picture is rendered, not silently dropped (D64/D85).",
        "slack.ts accepts staffingShorts but never renders it again.",
      ),
    );
  });
});

describe("owner intent — D87 bulk signature approve", () => {
  it("D87: several blocked campaigns are one bulk ask; execution covers the whole list", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    const check = await read("../services/campaignCheck.ts");
    assert.match(
      check,
      /notifyActionResult/,
      stop(
        "Several signature writes are one Slack after the fact (D92).",
        "campaignCheck.ts no longer tells Josh after it writes signatures.",
      ),
    );

    const { signatureCampaignIdsOf } = await import(
      "../lib/isolationActions.js"
    );
    assert.deepEqual(
      signatureCampaignIdsOf({ detail: { campaignIds: [7, 9], campaignId: 7 } }),
      [7, 9],
      stop(
        "A signature ask carries every campaign it covers (D87).",
        "signatureCampaignIdsOf no longer reads bulk campaignIds.",
      ),
    );

    const execute = await read("../services/isolationExecute.ts");
    assert.match(
      execute,
      /signatureCampaignIdsOf/,
      stop(
        "A bulk approve executes against the whole list (D87).",
        "isolationExecute.ts only writes a single campaignId again.",
      ),
    );
  });
});

describe("owner intent — D86 hand-bought canary fleet is adopted", () => {
  it("D86: adoption exists, runs from boot + monitor, and canaries never staff", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    const buy = await read("../services/copyCanaryBuy.ts");
    assert.match(
      buy,
      /adoptManualPurchase/,
      stop(
        "A fleet Josh buys by hand in InboxKit is adopted, not stranded (D86).",
        "copyCanaryBuy.ts lost adoptManualPurchase — a manual buy sits unregistered with warmup on again.",
      ),
    );
    assert.match(
      buy,
      /copyCanary: true/,
      stop(
        "Adopted canaries are flagged copyCanary so they never staff (D86).",
        "copyCanaryBuy.ts no longer flags fleet rows copyCanary.",
      ),
    );

    const index = await read("../index.ts");
    assert.match(
      index,
      /runCanaryAdoption/,
      stop(
        "Adoption runs at boot and on the monitor pass (D86).",
        "index.ts no longer calls the canary adoption pass.",
      ),
    );

    const provisioner = await read("../services/poolProvisioner.ts");
    assert.match(
      provisioner,
      /isCopyCanary\(email\)/,
      stop(
        "The pool provisioner never turns warmup on for a canary (D83/D86).",
        "poolProvisioner.ts lost the isCopyCanary skip.",
      ),
    );
  });
});

describe("owner intent — D88 bounce pause bands retired", () => {
  it("D88: the 20/7 pause bands stay unused; Smartlead off-write stays", async () => {
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
    assert.match(
      autostop,
      /bounce_autopause_threshold/,
      stop(
        "The bounce loop still writes Smartlead autopause off (D80/D88).",
        "campaignBounceAutostop.ts lost the Smartlead off-write.",
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

describe("owner intent — D90 bounce pause is 10% after 1k or 10-in-10m", () => {
  it("D90: pause over 10% after 1k leads, or more than 10 bounces in 10 minutes", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    assert.equal(
      defaults.bouncePauseMinLeads,
      1000,
      stop(
        "Rate pause needs 1,000 leads emailed (D90).",
        `Min leads is now ${defaults.bouncePauseMinLeads}.`,
      ),
    );
    assert.equal(
      defaults.bouncePauseRatePercent,
      10,
      stop(
        "Rate pause is over 10% (D90).",
        `Rate is now ${defaults.bouncePauseRatePercent}%.`,
      ),
    );
    assert.equal(
      defaults.bounceBurstCount,
      10,
      stop(
        "Burst pause is more than 10 new bounces in 10 minutes (D90).",
        `Burst count is now ${defaults.bounceBurstCount}.`,
      ),
    );

    const { shouldPauseCampaignForBounceRate, shouldPauseCampaignForBounceBurst } =
      await import("../lib/campaignBouncePause.js");
    assert.equal(
      shouldPauseCampaignForBounceRate(1000, 100),
      false,
      stop(
        "Exactly 10% after 1k must not pause (D90).",
        "shouldPauseCampaignForBounceRate now trips at 10% exactly.",
      ),
    );
    assert.equal(
      shouldPauseCampaignForBounceRate(1000, 101),
      true,
      stop(
        "Over 10% after 1k pauses (D90).",
        "shouldPauseCampaignForBounceRate no longer trips at 101/1000.",
      ),
    );
    assert.equal(
      shouldPauseCampaignForBounceRate(150, 40),
      false,
      stop(
        "The old 20/7 mid-volume sample is not a pause (D88/D90).",
        "A 150-send 20%+ campaign is being paused on the retired band.",
      ),
    );
    const now = Date.parse("2026-08-26T02:10:00.000Z");
    assert.equal(
      shouldPauseCampaignForBounceBurst(
        { bounced: 4, sent: 40, at: "2026-08-26T02:00:00.000Z" },
        15,
        now,
      ).trip,
      true,
      stop(
        "More than 10 new bounces in 10 minutes pauses (D90).",
        "The burst helper no longer trips on +11 in 10 minutes.",
      ),
    );

    const autostop = await read("../services/campaignBounceAutostop.ts");
    assert.match(
      autostop,
      /shouldPauseCampaignForBounceRate/,
      stop(
        "The 10-minute loop uses the D90 rate trip (D90).",
        "campaignBounceAutostop.ts lost the 10%/1k pause.",
      ),
    );
    assert.match(
      autostop,
      /shouldPauseCampaignForBounceBurst/,
      stop(
        "The 10-minute loop uses the D90 burst trip (D90).",
        "campaignBounceAutostop.ts lost the 10-bounces-in-10-minutes pause.",
      ),
    );
    assert.match(
      autostop,
      /updateCampaignStatus\(campaign\.id, "PAUSED"\)/,
      stop(
        "A D90 trip pauses the campaign (D90).",
        "campaignBounceAutostop.ts no longer writes PAUSED.",
      ),
    );
    assert.doesNotMatch(
      autostop,
      /updateCampaignStatus\([^)]*START/,
      stop(
        "A bounce pause is not auto-resumed (D40/D90).",
        "campaignBounceAutostop.ts STARTs a campaign again.",
      ),
    );
  });
});

describe("owner intent — D89 leftover canon holes", () => {
  it("D89: living known-good, queued reads, attach-after-adopt, bulk collapse, drafts on EOD", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    const pod = await read("../services/podControls.ts");
    assert.match(
      pod,
      /living\.has/,
      stop(
        "A stored pod-control test that is not living is not coverage (D89).",
        "podControls.ts treats a stored spamTestId as coverage even when the test is dead.",
      ),
    );

    const index = await read("../index.ts");
    assert.match(
      index,
      /pod-cover/,
      stop(
        "Health grows known-good coverage when findings say it is missing (D89).",
        "index.ts no longer runs a pod-cover pass.",
      ),
    );
    assert.match(
      index,
      /copyCanary\.attach\(\)/,
      stop(
        "Canary attach runs after adopt, not only inside health (D89).",
        "index.ts no longer attaches canary tests from the adopt pass.",
      ),
    );

    const smartlead = await read("../clients/smartlead.ts");
    assert.match(
      smartlead,
      /listCampaigns\(clientId\?: number\): Promise<SmartleadCampaign\[]> \{\s*return this\.mutate\(/,
      stop(
        "listCampaigns shares the write queue (D89).",
        "listCampaigns is an unqueued read again — four deploys will 429 inventory.",
      ),
    );
    assert.match(
      smartlead,
      /listClients\(\): Promise<SmartleadClientRecord\[]> \{\s*return this\.mutate\(/,
      stop(
        "listClients shares the write queue (D89).",
        "listClients is an unqueued read again.",
      ),
    );
    assert.match(
      smartlead,
      /listAllEmailAccounts[\s\S]*return this\.mutate\(/,
      stop(
        "listAllEmailAccounts shares the write queue (D89).",
        "listAllEmailAccounts is an unqueued read again.",
      ),
    );

    const check = await read("../services/campaignCheck.ts");
    assert.match(
      check,
      /autoApplySignature/,
      stop(
        "Signatures are written without a Slack approve (D92).",
        "campaignCheck.ts lost autoApplySignature.",
      ),
    );

    const brief = await read("../services/clientDayBrief.ts");
    assert.match(
      brief,
      /loadedDrafts/,
      stop(
        "DRAFT campaigns with remaining leads are named on the EOD brief (D89).",
        "clientDayBrief.ts dropped loaded drafts.",
      ),
    );
    const slackSrc = await read("../clients/slack.ts");
    assert.match(
      slackSrc,
      /Leads loaded, not sending/,
      stop(
        "The EOD brief renders loaded drafts in plain English (D89).",
        "slack.ts accepts loadedDrafts but never says leads are sitting in draft.",
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

describe("owner intent — D92 signature writes itself", () => {
  it("D92: checker writes the signature and Slacks after", async () => {
    const check = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/campaignCheck.ts", import.meta.url), "utf8"),
    );
    assert.match(
      check,
      /desiredMailboxSignature/,
      stop(
        "Mailbox signature is set to First Last / client name (D92).",
        "campaignCheck.ts no longer writes the two-line mailbox signature.",
      ),
    );
    assert.doesNotMatch(
      check,
      /kind: "add_signature_tag"/,
      stop(
        "Signature fix is not a Slack approve (D92).",
        "campaignCheck.ts still asks add_signature_tag.",
      ),
    );
  });
});

describe("owner intent — D93 word hunt is ESP-fail + known-good clean", () => {
  it("D93: suspects from any weak ESP; known-good fail is infra", async () => {
    const branch = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/isolationBranch.ts", import.meta.url), "utf8"),
    );
    assert.match(
      branch,
      /anyEspBelowThreshold/,
      stop(
        "A campaign copy test failing any ESP can start the word-hunt path (D93).",
        "isolationBranch.ts no longer reads per-ESP weakness.",
      ),
    );
    const verdict = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/isolationVerdict.ts", import.meta.url), "utf8"),
    );
    assert.match(
      verdict,
      /knownGoodFineAcrossEsps/,
      stop(
        "Known-good failing an ESP is infra, not a word hunt (D93).",
        "isolationVerdict.ts lost the known-good ESP-to-ESP gate.",
      ),
    );
  });
});

describe("owner intent — D96 unwarmed senders with that copy", () => {
  it("D96: word hunt waits for unwarmed copy; landing it is infra", async () => {
    const verdict = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/isolationVerdict.ts", import.meta.url), "utf8"),
    );
    assert.match(
      verdict,
      /unwarmedCopyFineAcrossEsps/,
      stop(
        "Infra vs copy reads unwarmed senders with that campaign copy (D96).",
        "isolationVerdict.ts no longer looks at unwarmedCopyFineAcrossEsps.",
      ),
    );
    assert.match(
      verdict,
      /unwarmedAlsoFailed/,
      stop(
        "Word hunt waits until unwarmed senders with that copy also fail (D96).",
        "isolationVerdict.ts starts COPY without an unwarmed-copy fail.",
      ),
    );
    const branch = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/isolationBranch.ts", import.meta.url), "utf8"),
    );
    assert.match(
      branch,
      /unwarmedCopyFineAcrossEsps/,
      stop(
        "The isolation branch scores the canary-copy test per ESP (D96).",
        "isolationBranch.ts no longer reads unwarmed copy ESP-to-ESP.",
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

describe("owner intent — D95 signature Slack once per campaign", () => {
  it("D95: first write Slacks; a leftover backfill does not re-ping", async () => {
    const check = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/campaignCheck.ts", import.meta.url), "utf8"),
    );
    assert.match(
      check,
      /sigAutoWrittenAt/,
      stop(
        "A leftover signature write does not Slack again (D95).",
        "campaignCheck.ts no longer records sigAutoWrittenAt.",
      ),
    );
    assert.match(
      check,
      /notifyActionResult/,
      stop(
        "Josh still gets told the first time a signature is written (D92/D95).",
        "campaignCheck.ts no longer Slacks after a new signature write.",
      ),
    );
  });
});

describe("owner intent — D99 BCP short is a hole", () => {
  it("D99: BCP-owned domains fan onto tagged BCP campaigns; held boxes do not inflate the floor", async () => {
    const fan = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/clientFanOut.ts", import.meta.url), "utf8"),
    );
    assert.match(
      fan,
      /groupIsBcp && isBcpOwnedDomain/,
      stop(
        "A BCP-owned inbox belongs on BCP campaigns even without client_id (D99).",
        "clientFanOut.ts no longer treats BCP domains as BCP inventory on id:N groups.",
      ),
    );
    const floor = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/clientStaffFloor.ts", import.meta.url), "utf8"),
    );
    assert.match(
      floor,
      /getHeldInbox/,
      stop(
        "Held inboxes do not inflate the half-floor (D99).",
        "countClientInboxesByKey counts HOLD-UNTIL boxes as sitting again.",
      ),
    );
  });
});

describe("owner intent — D101 sequence writes omit created_at", () => {
  it("D101: sequence POSTs go through sequencesForWrite", async () => {
    const qa = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/signatureQa.ts", import.meta.url), "utf8"),
    );
    assert.match(
      qa,
      /sequencesForWrite/,
      stop(
        "Sequence writes strip created_at (D101).",
        "signatureQa.ts lost sequencesForWrite.",
      ),
    );
    assert.match(
      qa,
      /email_campaign_id/,
      stop(
        "Sequence writes drop email_campaign_id (D103).",
        "sequencesForWrite no longer omits email_campaign_id.",
      ),
    );
    const client = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../clients/smartlead.ts", import.meta.url), "utf8"),
    );
    assert.match(
      client,
      /sequencesForWrite\(sequences\)/,
      stop(
        "updateCampaignSequences strips read-only timestamps (D101).",
        "smartlead.ts posts raw getCampaignSequences payloads again.",
      ),
    );
  });
});

describe("owner intent — D103 sequence writes keep only writable fields", () => {
  it("D103: sequencesForWrite allowlists writable keys and drops email_campaign_id", async () => {
    const qa = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/signatureQa.ts", import.meta.url), "utf8"),
    );
    assert.match(
      qa,
      /SEQUENCE_WRITE_KEEP/,
      stop(
        "Sequence writes keep only writable fields (D103).",
        "signatureQa.ts lost the writable allowlist.",
      ),
    );
    assert.match(
      qa,
      /email_campaign_id/,
      stop(
        "Sequence writes drop email_campaign_id (D103).",
        "sequencesForWrite no longer omits email_campaign_id.",
      ),
    );
  });
});

describe("owner intent — D105 warmup gate is on", () => {
  it("D105: 21-day warmup gate defaults on; canaries stay a separate fleet", () => {
    assert.equal(
      defaults.enableWarmupGate,
      true,
      stop(
        "The 21-day warmup gate is on for live senders (D105).",
        "ENABLE_WARMUP_GATE now defaults off.",
      ),
    );
    assert.equal(
      defaults.campaignMinWarmupDays,
      21,
      stop(
        "Live send owes 21 days from InboxKit (D50/D105).",
        `Campaign min warmup is now ${defaults.campaignMinWarmupDays}.`,
      ),
    );
  });
});

describe("owner intent — D106 85% launch bar is a live START gate", () => {
  it("D106: launch bar defaults to 85", () => {
    assert.equal(
      defaults.launchInboxThreshold,
      85,
      stop(
        "Auto-START needs 85% inbox (D106).",
        `LAUNCH_INBOX_THRESHOLD is now ${defaults.launchInboxThreshold}.`,
      ),
    );
  });
});

describe("owner intent — D107 old-client campaigns are deleted", () => {
  it("D107: Nieto / MSRS2 / Positive ids are the teardown list", () => {
    assert.deepEqual(
      defaults.oldClientCampaignIds,
      [3437329, 3628940, 3628943],
      stop(
        "Those three leftover campaigns are deleted (D107).",
        `OLD_CLIENT_CAMPAIGN_IDS is now ${defaults.oldClientCampaignIds.join(",")}.`,
      ),
    );
  });
});

describe("owner intent — D114 canary tests hang on a paused shell", () => {
  it("D114: canary POST uses the shell campaign_id, never the live one", async () => {
    const canary = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/copyCanary.ts", import.meta.url), "utf8"),
    );
    assert.match(
      canary,
      /ensureCanaryShell/,
      stop(
        "Canary tests hang on a paused per-campaign shell (D114).",
        "copyCanary.ts no longer ensures a canary shell.",
      ),
    );
    assert.match(
      canary,
      /campaignId:\s*shell\.campaignId/,
      stop(
        "Schedule sends the shell campaign_id (D114).",
        "copyCanary.ts no longer posts the shell campaign_id.",
      ),
    );
    assert.doesNotMatch(
      canary,
      /offCampaignSenders:\s*true/,
      stop(
        "D113's omit-campaign_id POST is superseded (D114).",
        "copyCanary.ts still marks the test off-campaign.",
      ),
    );
    const shell = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/canaryShell.ts", import.meta.url), "utf8"),
    );
    assert.match(
      shell,
      /isCanaryShellCampaign/,
      stop(
        "Canary shells are identified so morning START cannot launch them (D114).",
        "isCanaryShellCampaign is gone.",
      ),
    );
  });
});

describe("owner intent — D117 seed a real canary inbox then pause", () => {
  it("D117: fleet-inbox seed is superseded — still seed then pause", async () => {
    const { readFile } = await import("node:fs/promises");
    const canary = await readFile(
      new URL("../services/copyCanary.ts", import.meta.url),
      "utf8",
    );
    const shell = await readFile(
      new URL("../services/canaryShell.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      canary,
      /seedEmail:\s*senderAccounts\[0\]/,
      stop(
        "D117's fleet-inbox seed is superseded (D118).",
        "copyCanary.ts still seeds a canary sender as a lead.",
      ),
    );
    assert.match(
      shell,
      /seedShellLead[\s\S]*updateCampaignStatus\(campaign\.id, "PAUSED"\)/,
      stop(
        "Seed, then pause (D117, kept by D118).",
        "canaryShell.ts pauses before seeding again.",
      ),
    );
  });
});

describe("owner intent — D121 placement state marks match campaign id", () => {
  it("D121: a living test covers only the campaign it belongs to", async () => {
    const { readFile } = await import("node:fs/promises");
    const coverage = await readFile(
      new URL("../lib/placementCoverage.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      coverage,
      /livingCampaignByTestId/,
      stop(
        "State placement marks only count when the living test is for that campaign (D121).",
        "testedCampaignCoverage no longer maps living tests to their campaign id.",
      ),
    );
    assert.match(
      coverage,
      /livingCampaignByTestId\.get\(String\(id\)\) === String\(campaignId\)/,
      stop(
        "A living test on another campaign does not cover this one (D121).",
        "testedCampaignCoverage still treats any living testId as coverage.",
      ),
    );
  });
});

describe("owner intent — D122 no Smartlead boot kicks except attach", () => {
  it("D122: deploy starts attach only; health inventory retries 429", async () => {
    const { readFile } = await import("node:fs/promises");
    const index = await readFile(
      new URL("../index.ts", import.meta.url),
      "utf8",
    );
    const inventory = await readFile(
      new URL("../services/inventory.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      index,
      /void runHealth\(\)\.catch\(\(error\) => \{\s*console\.error\("\[health\] Boot kick failed"/,
      stop(
        "Health does not boot-kick after deploy (D122).",
        "index.ts still starts a health pass on a boot timer.",
      ),
    );
    assert.doesNotMatch(
      index,
      /void runPoolProvision\(\)\.catch\(\(error\) => \{\s*console\.error\("\[pool-provision\] Boot kick failed"/,
      stop(
        "Pool does not boot-kick after deploy (D122).",
        "index.ts still starts pool provision on a boot timer.",
      ),
    );
    assert.doesNotMatch(
      index,
      /\[boot\] campaign audit failed/,
      stop(
        "Campaign-audit does not run at listen (D122).",
        "index.ts still boots a Smartlead campaign-audit.",
      ),
    );
    assert.match(
      index,
      /reason: "health-running"/,
      stop(
        "Pool cron yields while a health pass is in flight (D122).",
        "runPoolProvision no longer skips when healthInFlight is set.",
      ),
    );
    assert.match(
      index,
      /Health pass running — skipping overlapping hourly sweep/,
      stop(
        "Hourly campaign-check yields while a health pass is in flight (D122).",
        "The :00 campaign-check cron still overlaps health's inventory.",
      ),
    );
    assert.match(
      inventory,
      /isSmartleadRateLimit/,
      stop(
        "Inventory retries a Smartlead 429 (D122).",
        "inventory.ts lost the rate-limit detector.",
      ),
    );
    assert.match(
      inventory,
      /INVENTORY_429_ATTEMPTS/,
      stop(
        "Inventory retries a 429 three times (D122).",
        "fetchInventory no longer retries rate limits.",
      ),
    );
    const scanner = await readFile(
      new URL("../services/campaignScanner.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      scanner,
      /Uncovered live campaigns=/,
      stop(
        "A placement scan names the uncovered live campaigns (D122).",
        "campaignScanner.ts no longer logs uncovered candidate ids.",
      ),
    );
  });
});

describe("owner intent — D123 state marks cover when enrich omits campaign_id", () => {
  it("D123: a living test with no campaign_id still covers the stored campaign", async () => {
    const coverage = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/placementCoverage.ts", import.meta.url), "utf8"),
    );
    assert.match(
      coverage,
      /livingTestIds/,
      stop(
        "State marks still count when enrich omits campaign_id (D123).",
        "testedCampaignCoverage no longer tracks living test ids without a campaign id.",
      ),
    );
    assert.match(
      coverage,
      /livingCid === undefined && livingTestIds\.has\(key\)/,
      stop(
        "A living test with no campaign_id covers the campaign we stored it on (D123).",
        "testedCampaignCoverage ignores state marks unless enrich returned a campaign id.",
      ),
    );
  });
});

describe("owner intent — D120 unique shell seed, not upload_count-only", () => {
  it("D120: each shell gets its own seed address; other-campaign skip is not success", async () => {
    const { readFile } = await import("node:fs/promises");
    const lib = await readFile(
      new URL("../lib/canaryShell.ts", import.meta.url),
      "utf8",
    );
    const shell = await readFile(
      new URL("../services/canaryShell.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      lib,
      /canaryShellSeedEmail/,
      stop(
        "Each canary shell seeds a unique instrumentation address (D120).",
        "canaryShellSeedEmail is gone.",
      ),
    );
    assert.match(
      lib,
      /existingLeadsInOtherCampaigns/,
      stop(
        "A lead that only exists on another campaign is not success (D120).",
        "shellLeadImportAccepted no longer mentions existingLeadsInOtherCampaigns.",
      ),
    );
    assert.match(
      shell,
      /canaryShellSeedEmail\(campaign\.id\)/,
      stop(
        "The default seed is per-shell, not one shared inbox (D120).",
        "canaryShell.ts still uses one shared CANARY_SHELL_SEED_EMAIL.",
      ),
    );
  });
});

describe("owner intent — D119 seed shells when SmartDelivery list fails", () => {
  it("D119: list is retried; list-fail still seeds the shell and does not schedule", async () => {
    const { readFile } = await import("node:fs/promises");
    const canary = await readFile(
      new URL("../services/copyCanary.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      canary,
      /listTestsRetrying/,
      stop(
        "SmartDelivery listTests is retried before attach gives up (D119).",
        "copyCanary.ts no longer retries listTests.",
      ),
    );
    assert.match(
      canary,
      /seedCanaryShell\(campaign, campaigns, picks, dryRun\);\s*throw new Error\("could not list SmartDelivery tests"\)/,
      stop(
        "A list failure still plants the shell lead (D119).",
        "copyCanary.ts throws on list-fail before seeding again.",
      ),
    );
    assert.match(
      canary,
      /if \(existing\) return existing;/,
      stop(
        "A stored canary is still reused when the list is down (D98/D119).",
        "copyCanary.ts no longer reuses the stored test id on list-fail.",
      ),
    );
  });
});

describe("owner intent — D118 parse the real import and seed a non-sender", () => {
  it("D118: non-sender seed, upload_count accepted, raw import logged", async () => {
    const { readFile } = await import("node:fs/promises");
    const lib = await readFile(
      new URL("../lib/canaryShell.ts", import.meta.url),
      "utf8",
    );
    const shell = await readFile(
      new URL("../services/canaryShell.ts", import.meta.url),
      "utf8",
    );
    const client = await readFile(
      new URL("../clients/smartlead.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      lib,
      /canary\.instrumentation@getcrosslaunchco\.info/,
      stop(
        "The shell lead is an instrumentation address, not a sending account (D118).",
        "CANARY_SHELL_SEED_EMAIL is no longer the non-sender seed.",
      ),
    );
    assert.match(
      lib,
      /upload_count/,
      stop(
        "Import success reads upload_count (D118).",
        "shellLeadImportAccepted no longer looks at upload_count.",
      ),
    );
    assert.match(
      lib,
      /already_added_to_campaign/,
      stop(
        "A lead already on the shell counts (D118).",
        "already_added_to_campaign is no longer accepted.",
      ),
    );
    assert.match(
      shell,
      /upload_count=/,
      stop(
        "Live logs must show the real import fields (D118).",
        "canary-shell seed log no longer prints upload_count.",
      ),
    );
    assert.match(
      shell,
      /raw=/,
      stop(
        "A failed seed must log the raw add/get bodies (D118).",
        "canaryShell.ts no longer logs the raw Smartlead JSON.",
      ),
    );
    assert.match(
      client,
      /addLeadsToCampaign/,
      stop(
        "Only the Smartlead client imports leads, and only for shells (D52/D118).",
        "addLeadsToCampaign is gone.",
      ),
    );
  });
});

describe("owner intent — D116 missing placement scans on that pass", () => {
  it("D116: no_placement_test kicks scan-backfill without the hourly wait", async () => {
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /if \(missingTest\) \{\s*await stage\("scan-backfill"/,
      stop(
        "A missing placement test is fixed on that health pass (D116).",
        "index.ts still waits 55 minutes before scan-backfill.",
      ),
    );
    assert.doesNotMatch(
      index,
      /missingTest && scanAgeMs >= 55/,
      stop(
        "The D84 hourly placement throttle is gone (D116).",
        "scan-backfill is still gated on a 55-minute clock.",
      ),
    );
  });
});

describe("owner intent — D115 canary shells get a dummy seed lead", () => {
  it("D115: only canary shells import the dummy seed; live campaigns never do", async () => {
    const { readFile } = await import("node:fs/promises");
    const shellLib = await readFile(
      new URL("../lib/canaryShell.ts", import.meta.url),
      "utf8",
    );
    const shellSvc = await readFile(
      new URL("../services/canaryShell.ts", import.meta.url),
      "utf8",
    );
    const canary = await readFile(
      new URL("../services/copyCanary.ts", import.meta.url),
      "utf8",
    );
    const runout = await readFile(
      new URL("../services/leadRunout.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      shellLib,
      /CANARY_SHELL_SEED_EMAIL/,
      stop(
        "The dummy seed address is named (D115).",
        "CANARY_SHELL_SEED_EMAIL is gone.",
      ),
    );
    assert.match(
      shellSvc,
      /addLeadsToCampaign/,
      stop(
        "Canary shells get the dummy seed so SmartDelivery will schedule (D115).",
        "canaryShell.ts no longer seeds a lead.",
      ),
    );
    assert.doesNotMatch(
      canary,
      /addLeadsToCampaign/,
      stop(
        "Live campaigns never get a lead import from copy-canary (D52/D115).",
        "copyCanary.ts now writes leads.",
      ),
    );
    assert.doesNotMatch(
      runout,
      /addLeadsToCampaign/,
      stop(
        "Lead runout still never imports (D52).",
        "leadRunout.ts now writes leads.",
      ),
    );
  });
});

describe("owner intent — D112 canary schedule omits sequence", () => {
  it("D112: schedule sends mapping id, not a custom sequence body", async () => {
    const placement = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/isolationPlacement.ts", import.meta.url), "utf8"),
    );
    assert.match(
      placement,
      /sequenceMappingId != null/,
      stop(
        "Campaign-bound schedule omits sequence when sequence_mapping_id is set (D112).",
        "isolationManualPayload still always sends sequence.",
      ),
    );
    assert.match(
      placement,
      /sequence_mapping_id: input.sequenceMappingId/,
      stop(
        "Canary schedule still sends sequence_mapping_id (D102/D112).",
        "isolationManualPayload dropped sequence_mapping_id.",
      ),
    );
  });
});

describe("owner intent — D111 old-client teardown retries leftovers", () => {
  it("D111: teardown keeps deleting remaining Nieto / MSRS / Positive", async () => {
    const teardown = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/oldClientTeardown.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(
      teardown,
      /if \(this\.state\.getOldClientTeardownAt\(\)\)/,
      stop(
        "Leftover old-client campaigns keep being deleted (D111).",
        "oldClientTeardown one-shot-skips after the first pass again.",
      ),
    );
    assert.match(
      teardown,
      /if \(!targets\.length\)/,
      stop(
        "Teardown only skips when no old-client campaigns remain (D111).",
        "oldClientTeardown no longer gates on remaining targets.",
      ),
    );
  });
});

describe("owner intent — D108 15-minute yes/no canon", () => {
  it("D108: health reports canonCompliant from core findings", async () => {
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /canonCompliant/,
      stop(
        " /health answers yes or no (D108).",
        "index.ts no longer reports canonCompliant.",
      ),
    );
    assert.match(
      index,
      /cronHealth/,
      stop(
        "The sweep is the 15-minute health pass (D108).",
        "index.ts lost cronHealth.",
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

describe("owner intent — D104 sequence writes remap sequence_variants", () => {
  it("D104: POST never sends sequence_variants (D110 remaps onto seq_variants)", async () => {
    const qa = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/signatureQa.ts", import.meta.url), "utf8"),
    );
    assert.match(
      qa,
      /key === "sequence_variants"/,
      stop(
        "POST must not send sequence_variants (D104).",
        "sequencesForWrite still forwards the GET key.",
      ),
    );
  });
});

describe("owner intent — D110 sequence writes send seq_variants", () => {
  it("D110: leftover signature writes emit seq_variants, never variants", async () => {
    const qa = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../lib/signatureQa.ts", import.meta.url), "utf8"),
    );
    assert.match(
      qa,
      /out\.seq_variants/,
      stop(
        "GET sequence_variants remap to seq_variants on write (D110).",
        "sequencesForWrite no longer emits seq_variants.",
      ),
    );
    assert.match(
      qa,
      /key === "variants"/,
      stop(
        "POST must not send variants (D110). Live rejected sequences[0].variants.",
        "sequencesForWrite still forwards variants.",
      ),
    );
  });
});

describe("owner intent — D100 canary schedule needs campaign_id", () => {
  it("D100/D114: canary senders stay off the live campaign", async () => {
    const canary = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/copyCanary.ts", import.meta.url), "utf8"),
    );
    assert.match(
      canary,
      /not the live campaign|paused canary shell|paused shells, not live/,
      stop(
        "Canary senders stay off live campaigns (D55/D100/D114).",
        "copyCanary.ts lost the off-live-campaign guarantee.",
      ),
    );
    assert.match(
      canary,
      /campaignId:\s*shell\.campaignId/,
      stop(
        "Schedule still sends a campaign_id (D100) — the shell's, not the live one (D114).",
        "copyCanary.ts no longer posts campaign_id.",
      ),
    );
  });
});

describe("owner intent — D102 canary schedule needs sequence_mapping_id", () => {
  it("D102/D114: canary still reads campaign copy and posts the shell mapping id", async () => {
    const canary = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/copyCanary.ts", import.meta.url), "utf8"),
    );
    assert.match(
      canary,
      /loadCampaignCopy/,
      stop(
        "Canary still reads campaign sequences for the copy body (D102/D114).",
        "copyCanary.ts no longer loads campaign copy.",
      ),
    );
    assert.match(
      canary,
      /sequenceMappingId:\s*shell\.sequenceMappingId/,
      stop(
        "Canary POST sends the shell sequence_mapping_id (D102/D114).",
        "copyCanary.ts no longer posts a mapping id.",
      ),
    );
  });
});

describe("owner intent — D98 find a hole, fix it", () => {
  it("D98: leftover signatures write on health; canary attach resolves providers; list-fail does not invent holes", async () => {
    const check = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/campaignCheck.ts", import.meta.url), "utf8"),
    );
    assert.match(
      check,
      /openSigFinding/,
      stop(
        "A leftover missing %signature% writes on the next health pass (D98).",
        "campaignCheck.ts no longer treats leftover signature findings as writable on first-pass.",
      ),
    );
    assert.match(
      check,
      /listedTestsFailed/,
      stop(
        "A failed SmartDelivery list does not invent placement or canary holes (D98).",
        "campaignCheck.ts stamps no_placement_test / missing_canary from an empty list again.",
      ),
    );
    const canary = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/copyCanary.ts", import.meta.url), "utf8"),
    );
    assert.match(
      canary,
      /resolveProviderIds/,
      stop(
        "Canary attach resolves provider ids the same way the scanner does (D98).",
        "copyCanary.ts no longer calls resolveProviderIds.",
      ),
    );
    assert.match(
      canary,
      /hasLivingUnwarmedCopyCanary/,
      stop(
        "A stored canary is reused only when it is still living (D98).",
        "copyCanary.ts returns a stored test id without checking the live list.",
      ),
    );
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /\[copy-canary\] \$\{err\}/,
      stop(
        "Each canary attach failure is logged, not only the count (D98).",
        "index.ts no longer logs individual copy-canary errors.",
      ),
    );
    const scan = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/campaignScanner.ts", import.meta.url), "utf8"),
    );
    assert.match(
      scan,
      /already-tested=/,
      stop(
        "Scanner logs why zero plans, not only No eligible campaigns (D98).",
        "campaignScanner.ts lost the candidate / already-tested counts.",
      ),
    );
  });
});

describe("owner intent — D124 force Smartlead autopause off once", () => {
  it("D124: one forced GET-echo write of 100; D84 drift after", async () => {
    const { readFile } = await import("node:fs/promises");
    const decisions = await readFile(
      new URL("../../DECISIONS.md", import.meta.url),
      "utf8",
    );
    assert.match(
      decisions,
      /## D124 — Force Smartlead bounce autopause off once/,
      stop(
        "Josh called a one-shot force-off of Smartlead autopause (D124).",
        "DECISIONS.md no longer has D124.",
      ),
    );
    assert.match(
      decisions,
      /bounce_autopause_threshold[\s\S]{0,200}100/,
      stop(
        "The force write is still 100 / off (D80/D124).",
        "D124 no longer says the force write is 100.",
      ),
    );
    const autostop = await readFile(
      new URL("../services/campaignBounceAutostop.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      autostop,
      /campaignSettingsWriteBody/,
      stop(
        "Autopause writes GET-echo settings so the Smartlead UI updates (D124).",
        "campaignBounceAutostop.ts posts only bounce_autopause_threshold again.",
      ),
    );
    assert.match(
      autostop,
      /getAutopauseForceAllAt/,
      stop(
        "The force-off is one pass, then D84 write-on-drift (D124).",
        "campaignBounceAutostop.ts lost the autopauseForceAllAt gate.",
      ),
    );
    assert.doesNotMatch(
      autostop,
      /updateCampaignStatus\([^)]*START/,
      stop(
        "The bounce loop still does not START anyone (D40/D124).",
        "campaignBounceAutostop.ts now STARTs a campaign.",
      ),
    );
    assert.match(
      autostop,
      /SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT/,
      stop(
        "Do not turn Smartlead bounce autopause on (D80/D124).",
        "campaignBounceAutostop.ts no longer converges to the off percent.",
      ),
    );
  });
});

describe("owner intent — D94 reconnect DCD mailboxes", () => {
  it("D94: health reconnects; Slack uses action_result", async () => {
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.match(
      index,
      /stage\("reconnect"/,
      stop(
        "Health reauths disconnected mailboxes (D94).",
        "index.ts no longer runs reconnect on the health pass.",
      ),
    );
    const slack = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../clients/slack.ts", import.meta.url), "utf8"),
    );
    assert.match(
      slack,
      /notifyReconnect[\s\S]*action_result/,
      stop(
        "A real reconnect is posted as an action result (D94).",
        "notifyReconnect is unclassified again — D71 drops it.",
      ),
    );
  });
});

describe("owner intent — D125 campaign signatures are the two-line rule", () => {
  it("D125: checker judges Name/Brand and writes leftover mailbox_sig", async () => {
    const check = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/campaignCheck.ts", import.meta.url), "utf8"),
    );
    assert.match(
      check,
      /mailboxSignatureMismatch/,
      stop(
        "Campaign-check audits two-line signatures, not only foreign brands (D125).",
        "campaignCheck.ts no longer uses mailboxSignatureMismatch.",
      ),
    );
    assert.match(
      check,
      /finding\.kind === "mailbox_sig"/,
      stop(
        "A leftover mailbox_sig is written on the check pass (D125).",
        "campaignCheck.ts no longer treats mailbox_sig as a writable leftover.",
      ),
    );
    const leftover = check.search(
      /missing_signature_tag"\)[\s\S]*mailbox_sig/,
    );
    assert.ok(
      leftover >= 0,
      stop(
        "Health leftover includes mailbox_sig as well as missing %signature% (D125).",
        "campaignCheck.ts leftover signature gate is tag-only again.",
      ),
    );
  });
});

describe("owner intent — D126 ops Placement is live senders", () => {
  it("D126: dashboard placement drops canary copy before the 40-test cap", async () => {
    const reporting = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/opsReporting.ts", import.meta.url), "utf8"),
    );
    assert.match(
      reporting,
      /titleHasCanaryCopyPhrase/,
      stop(
        "Ops Placement hides titles with canary copy (D126).",
        "opsReporting.ts lost titleHasCanaryCopyPhrase.",
      ),
    );
    assert.match(
      reporting,
      /isLiveSendingCampaignStatus/,
      stop(
        "Ops Placement is ACTIVE/START sending campaigns (D126).",
        "opsReporting.ts no longer gates on live sending status.",
      ),
    );
    const filterThenSlice = reporting.search(
      /titleHasCanaryCopyPhrase[\s\S]*\.slice\(0, 40\)/,
    );
    assert.ok(
      filterThenSlice >= 0,
      stop(
        "Canary copy is filtered before the 40-report ceiling (D126).",
        "opsReporting.ts no longer filters canary copy before slice(0, 40).",
      ),
    );
  });
});

describe("owner intent — D127 canon rebuild", () => {
  it("D127: CANON.md is the rules source and CLAUDE.md points at it", async () => {
    const { readFile } = await import("node:fs/promises");
    const decisions = await readFile(
      new URL("../../DECISIONS.md", import.meta.url),
      "utf8",
    );
    assert.match(
      decisions,
      /## D127 — The canon rebuild/,
      stop(
        "Josh delegated the canon rebuild and its standing rules (D127).",
        "DECISIONS.md no longer has D127.",
      ),
    );
    const claude = await readFile(
      new URL("../../CLAUDE.md", import.meta.url),
      "utf8",
    );
    assert.match(
      claude,
      /CANON\.md/,
      stop(
        "Sessions are pointed at CANON.md for the rules (D127).",
        "CLAUDE.md no longer references CANON.md.",
      ),
    );
    const canon = await readFile(
      new URL("../../CANON.md", import.meta.url),
      "utf8",
    );
    assert.match(
      canon,
      /Canon as of \*\*D\d+\*\*/,
      stop(
        "CANON.md declares which decision it is current through (D127).",
        "CANON.md lost its 'Canon as of' declaration.",
      ),
    );
  });
});

describe("owner intent — D128 live paths obey the ledger", () => {
  it("D128: no HOLD pull; qa-unpause gated by the bar and the bounce stamp", async () => {
    const { readFile } = await import("node:fs/promises");
    const gate = await readFile(
      new URL("../services/warmupGate.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      gate,
      /reason: "hold_until"/,
      stop(
        "A HOLD-UNTIL tag is inert residue, never a pull (D51/D59/D128).",
        "warmupGate.ts removes mailboxes for hold_until again.",
      ),
    );
    const qa = await readFile(
      new URL("../services/unpauseAfterSigQa.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      qa,
      /isBouncePaused/,
      stop(
        "qa-unpause never STARTs a campaign the D90 bounce loop paused (D128).",
        "unpauseAfterSigQa.ts no longer consults the bounce-pause stamp.",
      ),
    );
    assert.match(
      qa,
      /launchInboxThreshold/,
      stop(
        "qa-unpause requires the 85% launch bar before START (D106/D128).",
        "unpauseAfterSigQa.ts no longer reads the launch bar.",
      ),
    );
    const autostop = await readFile(
      new URL("../services/campaignBounceAutostop.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      autostop,
      /markBouncePaused/,
      stop(
        "The bounce loop stamps its pauses so nothing auto-STARTs them (D90/D128).",
        "campaignBounceAutostop.ts no longer stamps bounce pauses.",
      ),
    );
    const prompt = await readFile(
      new URL("../ops/campaignSetupPrompt.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      prompt,
      /D80|20% until 500|100 sends at 20%/,
      stop(
        "The agent brief teaches D90, not the retired bands (D128).",
        "campaignSetupPrompt.ts mentions the 20/7 bands again.",
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

describe("owner intent — D131 findings the sweep can close are closed", () => {
  it("D131: shells converge, pods cover per email, monitor is watchdogged", async () => {
    const { readFile } = await import("node:fs/promises");
    const canary = await readFile(
      new URL("../services/canaryShell.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      canary,
      /status: "PAUSED" \};/,
      stop(
        "A freshly created shell records its honest DRAFTED status so the pause runs (D131).",
        "canaryShell.ts fabricates a PAUSED status on create again.",
      ),
    );
    const pods = await readFile(
      new URL("../services/podControls.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      pods,
      /uncovered/,
      stop(
        "Pod-control coverage is per email — newcomers get supplemental tests (D131).",
        "podControls.ts went back to chunk-key-only coverage.",
      ),
    );
    const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(
      index,
      /stage\("dns-audit"/,
      stop(
        "Monitor stages are watchdogged into stageHealth (D131).",
        "index.ts runs monitor stages outside the watchdog again.",
      ),
    );
    const { STAGE_OVERDUE_WINDOWS_MS } = await import("../lib/stageWindows.js");
    const staged = [...index.matchAll(/stage\("([a-z0-9-]+)"/g)].map((m) => m[1]);
    assert.ok(staged.length >= 25, "the stage() calls in index.ts should be findable");
    for (const name of staged) {
      assert.ok(
        name in STAGE_OVERDUE_WINDOWS_MS,
        stop(
          `Stage "${name}" needs a cadence window in stageWindows.ts (D131).`,
          "The registry is also the boot prune list — an unlisted stage's record is dropped on deploy.",
        ),
      );
    }
  });
});

describe("owner intent — D132 one account book", () => {
  it("D132: audit, board and hourly check read the shared book; partial reads are distrusted", async () => {
    const { readFile } = await import("node:fs/promises");
    const inventory = await readFile(
      new URL("../services/inventory.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      inventory,
      /class InventoryBook/,
      stop(
        "One Smartlead account book serves the whole machine (D132).",
        "inventory.ts lost the shared book.",
      ),
    );
    assert.match(
      inventory,
      /shrunkenStreak/,
      stop(
        "A shrunken account book needs two consecutive reads to be believed (D132).",
        "inventory.ts lost the partial-read gate.",
      ),
    );
    const audit = await readFile(
      new URL("../services/campaignAudit.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      audit,
      /listAllEmailAccounts|listCampaigns\(\)/,
      stop(
        "The campaign audit reads the shared book, never its own fetch (D132).",
        "campaignAudit.ts refetches the account book again.",
      ),
    );
    const ops = await readFile(
      new URL("../services/opsReporting.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      ops,
      /listAllEmailAccounts|listCampaigns\(\)/,
      stop(
        "The /ops board reads the shared book, never its own fetch (D132).",
        "opsReporting.ts refetches the account book again.",
      ),
    );
    const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(
      index,
      /mode: "hourly", inventory/,
      stop(
        "The hourly campaign check is handed the shared book's snapshot (D132).",
        "index.ts runs the hourly sweep on its own fetch again.",
      ),
    );
  });
});
