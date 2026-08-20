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

  it("D1: pool warmup is 14 days", () => {
    assert.equal(
      defaults.poolWarmupDays,
      14,
      stop(
        "A mailbox owes 14 days from InboxKit import before going live (D1).",
        `Pool warmup is now ${defaults.poolWarmupDays} days.`,
      ),
    );
  });

  it("D5: rotation thresholds are 80% placement and 5% bounce", () => {
    assert.equal(
      defaults.remediationInboxThreshold,
      80,
      stop(
        "Senders below 80% placement are rotated out (D5).",
        `Placement threshold is now ${defaults.remediationInboxThreshold}%.`,
      ),
    );
    assert.equal(
      defaults.bounceRateThreshold,
      5,
      stop(
        "Senders above 5% bounce are rotated out (D5).",
        `Bounce threshold is now ${defaults.bounceRateThreshold}%.`,
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

  it("D8: the placement test quota is 120", () => {
    assert.equal(
      defaults.totalTestQuota,
      120,
      stop(
        "No more than 120 concurrent placement tests (D8).",
        `Quota is now ${defaults.totalTestQuota}, which may exceed the SmartDelivery plan.`,
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

  it("D42: warmup reputation rotates independently of placement and bounce", async () => {
    const { shouldRotateForWarmupReputation, parseWarmupReputation } =
      await import("../lib/warmupReputation.js");

    assert.equal(
      shouldRotateForWarmupReputation(61, defaults.warmupReputationThreshold),
      true,
      stop(
        "A collapsed warmup reputation pulls a sender (D42).",
        "The crossscaleco band (61-77%) no longer rotates at the default threshold.",
      ),
    );
    assert.equal(
      shouldRotateForWarmupReputation(null, defaults.warmupReputationThreshold),
      false,
      stop(
        "A missing reputation reading is not a damaged mailbox (D42).",
        "A null reading now rotates, which would bench every thinly-reported account.",
      ),
    );
    assert.equal(
      parseWarmupReputation({ warmup_details: { warmup_reputation: "0%" } }),
      0,
      stop(
        "A real 0% reputation is a reading, not a missing value (D42).",
        "0% now parses as null, so dead mailboxes would stay on campaigns.",
      ),
    );
    assert.equal(
      defaults.enableWarmupReputationRotation,
      false,
      stop(
        "Reputation rotation ships OFF until replacements are staffed (D42).",
        "It now defaults on — enabling it pulls 36 mailboxes at once, 23 from a campaign already at the MIN_CAMPAIGN_SENDERS floor.",
      ),
    );

    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/remediation.ts", import.meta.url), "utf8"),
    );
    assert.ok(
      /!bounceDriven && !reputationDriven/.test(src),
      stop(
        "A damaged mailbox is not a copy problem (D28 + D42).",
        "The copy-defer branch can now swallow a reputation-driven pull.",
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
