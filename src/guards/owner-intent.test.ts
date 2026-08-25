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

  it("D6: recovery hold is 14 days", () => {
    assert.equal(
      defaults.recoveryHoldDays,
      14,
      stop(
        "A benched sender sits 14 days before returning (D6).",
        `Recovery hold is now ${defaults.recoveryHoldDays} days.`,
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
    assert.equal(
      defaults.enableLegacyMailboxPulls,
      false,
      stop(
        "Placement / bounce / HOLD no longer pull a live mailbox (D51).",
        "ENABLE_LEGACY_MAILBOX_PULLS now defaults on.",
      ),
    );
  });

  it("D32: never rotate on blended placement — same-ESP scoring stays on", async () => {
    assert.equal(
      defaults.scoreSameEspOnly,
      true,
      stop(
        "Placement rotation uses same-ESP scores only (D32).",
        "SCORE_SAME_ESP_ONLY is off, so blended all-ESP scores can bench mailboxes again.",
      ),
    );
    const { shouldRotateForPlacement } = await import(
      "../lib/placementRotation.js"
    );
    assert.equal(
      shouldRotateForPlacement(
        { inboxRate: 10, scoredSameEsp: false },
        defaults.remediationInboxThreshold,
        { scoreSameEspOnly: true },
      ),
      false,
      stop(
        "Blended (non-same-ESP) scores must not rotate senders (D32).",
        "shouldRotateForPlacement now returns true for scoredSameEsp=false.",
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

  it("D7: campaign top-up is on with a 50-sender floor", () => {
    assert.equal(
      defaults.enableCampaignTopUp,
      true,
      stop(
        "Thin campaigns are refilled automatically (D7).",
        "Top-up now defaults off, so a campaign that launches thin stays thin.",
      ),
    );
    assert.equal(
      defaults.minCampaignSenders,
      50,
      stop(
        "Active campaigns are held at 50 senders (D7).",
        `The floor is now ${defaults.minCampaignSenders}, changing live campaign staffing.`,
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

  it("D29: paused-campaign bounce investigate threshold is 7%", () => {
    assert.equal(
      defaults.campaignBounceInvestigateThreshold,
      7,
      stop(
        "Paused campaigns with >7% aggregate sender bounce are investigated (D29).",
        `Investigate threshold is now ${defaults.campaignBounceInvestigateThreshold}%.`,
      ),
    );
  });

  it("D40: bounce investigate must not auto-START paused campaigns", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../services/campaignBounceInvestigate.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(
      /updateCampaignStatus\([^)]*START/.test(src),
      false,
      stop(
        "Manual pause/stop must not be auto-resumed (D40).",
        "CampaignBounceInvestigateService still calls updateCampaignStatus(..., START).",
      ),
    );
  });

  it("D28: copySignal defers Outlook-buried / Gmail-ok as copy", async () => {
    const { classifyCopySignal, shouldDeferSenderRotationForCopy } =
      await import("../lib/copySignal.js");
    const signal = classifyCopySignal([
      { name: "Outlook", inboxPercent: 10 },
      { name: "Gmail", inboxPercent: 70 },
    ]);
    assert.equal(
      shouldDeferSenderRotationForCopy(signal),
      true,
      stop(
        "Copy-likely placement must defer sender rotation (D28).",
        "Outlook-buried + Gmail-ok no longer defers rotation.",
      ),
    );
  });

  it("D36: copySignal defers a wide provider split in either direction", async () => {
    const { classifyCopySignal, shouldDeferSenderRotationForCopy } =
      await import("../lib/copySignal.js");
    // Gmail buried, Outlook perfect — the Goliath shape D28 alone missed.
    const gmailBuried = classifyCopySignal([
      { name: "Office365", inboxPercent: 100 },
      { name: "G Suite", inboxPercent: 36.4 },
    ]);
    assert.equal(
      shouldDeferSenderRotationForCopy(gmailBuried),
      true,
      stop(
        "A wide provider split is copy, whichever provider is buried (D36).",
        "Gmail-buried placement no longer defers rotation, so senders get benched for a copy problem.",
      ),
    );
    // Everything weak together is not a copy call — could be the domain.
    const allWeak = classifyCopySignal([
      { name: "Office365", inboxPercent: 60 },
      { name: "G Suite", inboxPercent: 10 },
    ]);
    assert.equal(
      shouldDeferSenderRotationForCopy(allWeak),
      false,
      stop(
        "Divergence needs a healthy provider to diverge from (D36).",
        "Campaigns weak on every provider now defer rotation, which would stall real remediation.",
      ),
    );
  });

  it("D39: held placement tests and client day brief stay on", () => {
    assert.equal(
      defaults.enableHeldPlacementTests,
      true,
      stop(
        "Held/pulled mailboxes get separate SmartDelivery tests (D39).",
        "ENABLE_HELD_PLACEMENT_TESTS now defaults off, so pulled mailboxes earn no fresh same-ESP score.",
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
  it("D41: client rest and rest-placement tests default on", () => {
    assert.equal(
      defaults.enableClientRest,
      true,
      stop(
        "Client inboxes rest 2 weeks on / 2 weeks off (D41).",
        "ENABLE_CLIENT_REST now defaults off, so client inboxes stay on campaigns every week.",
      ),
    );
    assert.equal(
      defaults.enableRestPlacementTests,
      true,
      stop(
        "Off-week client inboxes get separate SmartDelivery tests (D41).",
        "ENABLE_REST_PLACEMENT_TESTS now defaults off.",
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

  it("D41: bounce warn is 2%; pull stays 5%; paused investigate stays 7%", () => {
    assert.equal(
      defaults.bounceRateWarnThreshold,
      2,
      stop(
        "Bounce warns at 2% without pulling (D41).",
        `Warn threshold is now ${defaults.bounceRateWarnThreshold}%.`,
      ),
    );
    assert.equal(
      defaults.bounceRateThreshold,
      5,
      stop(
        "Senders above 5% bounce are still rotated out (D5).",
        `Bounce pull is now ${defaults.bounceRateThreshold}%.`,
      ),
    );
    assert.equal(
      defaults.campaignBounceInvestigateThreshold,
      7,
      stop(
        "Paused-campaign investigate stays 7% (D29).",
        `Investigate threshold is now ${defaults.campaignBounceInvestigateThreshold}%.`,
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
  it("D44: one-shot rebuild defaults on; only same-ESP fails stay held", async () => {
    assert.equal(
      defaults.enableRestBaselineRebuild,
      true,
      stop(
        "Unproven HOLDs are rebuilt once so D43 can rest (D44).",
        "ENABLE_REST_BASELINE_REBUILD now defaults off.",
      ),
    );
    const { holdHasSameEspProof } = await import("../lib/holdProof.js");
    assert.equal(
      holdHasSameEspProof(
        { scoredSameEsp: true, inboxRateSameEsp: 40 },
        80,
      ),
      true,
      stop(
        "A same-ESP fail stays held (D32/D44).",
        "Proven same-ESP holds are no longer kept.",
      ),
    );
    assert.equal(
      holdHasSameEspProof({ scoredSameEsp: false, inboxRate: 40 }, 80),
      false,
      stop(
        "Blended-only HOLDs are not proof (D44).",
        "A blended-only hold now counts as proven-weak.",
      ),
    );
    assert.equal(
      holdHasSameEspProof({ inboxRate: 40 }, 80),
      false,
      stop(
        "No same-ESP score is not proof (D44).",
        "A no-score hold now counts as proven-weak.",
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
  it("D50: live-send warmup is 21 days; recovery hold and generic rest stay 14", () => {
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
        "21 days is the warmed-vs-unwarmed clock (D50). The gate does not pull (D51).",
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
      defaults.recoveryHoldDays,
      14,
      stop(
        "Recovery hold after a bounce / placement pull stays 14 days (D6).",
        `Recovery hold is now ${defaults.recoveryHoldDays} days.`,
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
  it("D51: no placement/bounce/warmup pulls; copy canaries stay on campaign copy", () => {
    assert.equal(
      defaults.enableWarmupGate,
      false,
      stop(
        "The warmup gate does not strip campaign copy (D51).",
        "ENABLE_WARMUP_GATE now defaults on.",
      ),
    );
    assert.equal(
      defaults.enableBounceRotation,
      false,
      stop(
        "Bounce does not pull a live mailbox (D51).",
        "ENABLE_BOUNCE_ROTATION now defaults on.",
      ),
    );
    assert.equal(
      defaults.enableLegacyMailboxPulls,
      false,
      stop(
        "The only automatic live pull is Josh killing a mailbox (D51).",
        "ENABLE_LEGACY_MAILBOX_PULLS now defaults on.",
      ),
    );
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
      defaults.enableRemediation,
      false,
      stop(
        "Remediation stays off so placement pull cannot sneak back (D51).",
        "ENABLE_REMEDIATION now defaults on.",
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
  it("D61: Vasco keeps 40 and GXA/MSRS/Nieto are wipe targets", async () => {
    assert.equal(
      defaults.vascoKeepCount,
      40,
      stop(
        "Vasco keeps 40 inboxes (D61).",
        `VASCO_KEEP_COUNT is now ${defaults.vascoKeepCount}.`,
      ),
    );
    assert.deepEqual(
      defaults.wipeClientPatterns,
      ["gxa", "msrs", "nieto"],
      stop(
        "GXA, MSRS, and Nieto are the wipe list (D61).",
        `WIPE_CLIENT_PATTERNS is now ${defaults.wipeClientPatterns.join(",")}.`,
      ),
    );
    assert.deepEqual(
      defaults.fullSendClientPatterns,
      ["vasco"],
      stop(
        "Vasco sends all remaining inboxes — no A/B sit (D61).",
        `FULL_SEND_CLIENT_PATTERNS is now ${defaults.fullSendClientPatterns.join(",")}.`,
      ),
    );
    assert.equal(
      defaults.enableClientWipe,
      true,
      stop(
        "The Vasco trim / client wipe defaults on (D61).",
        "ENABLE_CLIENT_WIPE now defaults off.",
      ),
    );
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../services/clientWipe.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      src,
      /deleteEmailAccount/,
      stop(
        "Wipe deletes Smartlead accounts (D61).",
        "clientWipe.ts no longer deletes Smartlead accounts.",
      ),
    );
    assert.match(
      src,
      /purgeDomain|cancelMailboxes/,
      stop(
        "Wipe cancels InboxKit mailboxes and purges empty domains (D61).",
        "clientWipe.ts no longer touches InboxKit.",
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
    const rem = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/remediation.ts", import.meta.url), "utf8"),
    );
    assert.equal(
      /Low inbox looks like/.test(rem),
      false,
      stop(
        "Do not Slack a copy/offer guess (D69).",
        "remediation.ts still Slacks the copy-signal guess.",
      ),
    );
    assert.match(
      rem,
      /markCopySuspect/,
      stop(
        "Copy suspects still start the canary + word hunt (D69).",
        "remediation.ts no longer marks copy suspects.",
      ),
    );
    const bounce = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../services/campaignBounceInvestigate.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(
      /this looks like the copy or offer/.test(bounce),
      false,
      stop(
        "Paused-bounce copy defer is not a Slack guess (D69).",
        "campaignBounceInvestigate.ts still Slacks a copy guess.",
      ),
    );
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

describe("owner intent — D58 Goliath-only generics", () => {
  it("D58: floor is half the client's inboxes; generics stay on Goliath", async () => {
    const { clientInboxStaffFloor, allowsGenericStaff } = await import(
      "../lib/clientStaffFloor.js"
    );
    assert.equal(
      clientInboxStaffFloor(80),
      40,
      stop(
        "Vasco's 80 client inboxes mean a 40-sender floor (D58).",
        `Half-inbox floor is now ${clientInboxStaffFloor(80)}.`,
      ),
    );
    assert.equal(
      allowsGenericStaff({ name: "Goliath Displacement" }, "Goliath", ["goliath"]),
      true,
      stop(
        "Goliath may still receive generics (D58).",
        "allowsGenericStaff no longer matches Goliath.",
      ),
    );
    assert.equal(
      allowsGenericStaff({ name: "Vasco - Service" }, "Vasco Warranty", [
        "goliath",
      ]),
      false,
      stop(
        "Non-Goliath campaigns are client-inbox only (D58).",
        "allowsGenericStaff now treats Vasco as generic-eligible.",
      ),
    );
    assert.deepEqual(
      defaults.genericStaffNamePatterns,
      ["goliath"],
      stop(
        "Only Goliath is on the generic-staff allowlist by default (D58).",
        `GENERIC_STAFF_NAME_PATTERNS is now ${defaults.genericStaffNamePatterns.join(",")}.`,
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
      /pullNonGoliathGenerics/,
      stop(
        "Top-up pulls generics off every campaign that is not Goliath (D58).",
        "campaignTopUp.ts no longer pulls non-Goliath generics.",
      ),
    );
    assert.match(
      topUp,
      /D58 client-inbox only/,
      stop(
        "Top-up will not restaff non-Goliath campaigns with generics (D58).",
        "campaignTopUp.ts assigns generics to non-Goliath campaigns again.",
      ),
    );
    assert.match(
      fanOut,
      /D58 generics stay on Goliath only/,
      stop(
        "Fan-out must not put generics back on a non-Goliath client (D58).",
        "clientFanOut.ts no longer skips generics for non-Goliath groups.",
      ),
    );
  });
});

describe("owner intent — D59 clean slate", () => {
  it("D59: leftover unhealthy marks do not keep a B-pod box off", async () => {
    const { shouldVetoRestRestore } = await import("../services/clientRest.js");
    assert.equal(
      shouldVetoRestRestore(10, 80),
      false,
      stop(
        "Old same-ESP scores are not unhealth (D59).",
        "Client rest still vetoes restore on a leftover placement miss.",
      ),
    );
    assert.equal(
      defaults.enableUnhealthyReset,
      true,
      stop(
        "The one-shot unhealthy wipe defaults on (D59).",
        "ENABLE_UNHEALTHY_RESET now defaults off.",
      ),
    );

    const { readFile } = await import("node:fs/promises");
    const reset = await readFile(
      new URL("../services/unhealthyReset.ts", import.meta.url),
      "utf8",
    );
    const rest = await readFile(
      new URL("../services/clientRest.ts", import.meta.url),
      "utf8",
    );
    const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(
      reset,
      /clearAllHeldInboxes/,
      stop(
        "The wipe deletes every heldInboxes record (D59).",
        "unhealthyReset.ts no longer clears all holds.",
      ),
    );
    assert.match(
      rest,
      /onWeekTargets/,
      stop(
        "On-week client inboxes go on every live campaign for that client (D59).",
        "clientRest.ts no longer restaffs the full B pod.",
      ),
    );
    assert.match(
      index,
      /unhealthyReset\.run/,
      stop(
        "Health runs the wipe before rest/top-up (D59).",
        "index.ts no longer calls UnhealthyResetService.",
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
      /isPodControlShellCampaign/,
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
