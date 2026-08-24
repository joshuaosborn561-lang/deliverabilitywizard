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
        "Cayden can no longer tap Switch the word.",
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
      /until Josh or Cayden tap Switch the word/i,
      stop(
        "Live copy changes only after Josh or Cayden approve (D49).",
        "campaignSetupPrompt no longer names the Slack tap.",
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
