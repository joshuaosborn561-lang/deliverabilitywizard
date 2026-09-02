import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { isExcluded } from "../services/campaignTopUp.js";
import { scoreNameMatch, MATCH_THRESHOLD } from "../lib/nameMatch.js";
import { shouldRotateForBounces } from "../lib/bounceRate.js";

/**
 * Guards for the LIVE rules — the canon in CANON.md. A failure here means
 * someone is reversing a deliberate call, not that they hit a bug. See
 * DECISIONS.md for why each rule exists; retired-machinery guards live in
 * retired.test.ts and process guards in meta.test.ts.
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
    // Copy suspects come from delivery watch (D69) and from ugly same-ESP
    // canary/placement scores (D158), which feed the D93/D96 verdict.
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
      /Replacing this exact phrase\/word: \*free\*/,
      stop(
        "The Slack names the exact phrase being replaced (D69/D153).",
        "copySwapProof no longer names the find phrase.",
      ),
    );
    assert.match(
      proof,
      /Write my own edit|Use suggested edit|Make the changes/,
      stop(
        "The Slack asks for a human tap to apply the edit (D69/D153).",
        "copySwapProof no longer asks for a tap.",
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
    // D157 — the autopause-converge knobs are deleted outright: the API
    // field is handler-discarded, so a config default implying an
    // off-write would be a lie about a control we do not have.
    const configSrc = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../config.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(
      configSrc,
      /smartleadBounceAutopauseOffPercent|enableBounceAutopauseConverge/,
      stop(
        "There is no Smartlead autopause write to configure (D157).",
        "config.ts grew the autopause-converge knobs back.",
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
    assert.doesNotMatch(
      autostop,
      /updateCampaignSettings|getCampaignSettings/,
      stop(
        "The bounce loop writes no Smartlead settings at all (D84/D157).",
        "campaignBounceAutostop.ts touches campaign settings again — the field it once chased is handler-discarded.",
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

describe("owner intent — D141 a bounce burst is fresh sends, never a ledger dump", () => {
  it("D141: burst-only, recency-gated; the D90 lifetime-rate rule stays retired", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    assert.equal(
      defaults.bounceBurstCount,
      10,
      stop(
        "Burst pause is more than 10 new bounces in 10 minutes (D141).",
        `Burst count is now ${defaults.bounceBurstCount}.`,
      ),
    );
    assert.ok(
      !("bouncePauseMinLeads" in defaults) &&
        !("bouncePauseRatePercent" in defaults),
      stop(
        "The lifetime-rate pause is retired — verified lists never bounce like that (D141, Josh 2026-08-27).",
        "config grew the D90 rate knobs back.",
      ),
    );

    const pauseLib = (await import("../lib/campaignBouncePause.js")) as Record<
      string,
      unknown
    >;
    assert.equal(
      "shouldPauseCampaignForBounceRate" in pauseLib,
      false,
      stop(
        "The rate trip is deleted, not parked (D141).",
        "campaignBouncePause.ts exports shouldPauseCampaignForBounceRate again.",
      ),
    );
    const { shouldPauseCampaignForBounceBurst, freshBounceSamples } =
      pauseLib as {
        shouldPauseCampaignForBounceBurst: typeof import("../lib/campaignBouncePause.js").shouldPauseCampaignForBounceBurst;
        freshBounceSamples: typeof import("../lib/campaignBouncePause.js").freshBounceSamples;
      };
    const now = Date.parse("2026-08-26T02:10:00.000Z");
    assert.equal(
      shouldPauseCampaignForBounceBurst(
        { bounced: 4, sent: 40, at: "2026-08-26T02:00:00.000Z" },
        15,
        now,
      ).trip,
      true,
      stop(
        "More than 10 new bounces in 10 minutes trips the burst (D141).",
        "The burst helper no longer trips on +11 in 10 minutes.",
      ),
    );
    // The 2026-08-27 false positive: 12 bounces batch-recorded whose sends
    // were 3-14 days old must read as zero fresh.
    const staleOnly = freshBounceSamples(
      [
        { sent_time: "2026-08-13T14:05:53.775Z" },
        { sent_time: "2026-08-20T16:34:22.414Z" },
      ],
      Date.parse("2026-08-27T01:10:00.000Z"),
    );
    assert.equal(
      staleOnly.fresh,
      0,
      stop(
        "A bounced send older than 24h is ledger residue, not a live burst (D141).",
        "freshBounceSamples counts stale sends as fresh.",
      ),
    );
    assert.equal(
      freshBounceSamples(
        [{ sent_time: "2026-08-27T00:50:00.000Z" }],
        Date.parse("2026-08-27T01:10:00.000Z"),
      ).fresh,
      1,
      stop(
        "A bounced send from the last 24h counts as live (D141).",
        "freshBounceSamples no longer sees a fresh send.",
      ),
    );

    const autostop = await read("../services/campaignBounceAutostop.ts");
    assert.doesNotMatch(
      autostop,
      /shouldPauseCampaignForBounceRate/,
      stop(
        "The 10-minute loop has no lifetime-rate pause (D141).",
        "campaignBounceAutostop.ts calls the retired rate trip.",
      ),
    );
    assert.match(
      autostop,
      /shouldPauseCampaignForBounceBurst/,
      stop(
        "The 10-minute loop uses the burst trip (D141).",
        "campaignBounceAutostop.ts lost the 10-bounces-in-10-minutes trip.",
      ),
    );
    assert.match(
      autostop,
      /freshBounceSamples\(rows, nowMs\)/,
      stop(
        "A tripped burst samples the bounced rows and acts only on fresh sends (D141).",
        "campaignBounceAutostop.ts acts on the counter delta alone again.",
      ),
    );
    assert.match(
      autostop,
      /recency\.fresh === 0/,
      stop(
        "A ledger dump of stale bounces logs and never pauses (D141).",
        "campaignBounceAutostop.ts lost the dump branch.",
      ),
    );
    assert.match(
      autostop,
      /rows == null/,
      stop(
        "Unreadable rows defer the decision to the next tick — the snapshot is not consumed (D141).",
        "campaignBounceAutostop.ts no longer re-checks when the ledger lags.",
      ),
    );
    assert.match(
      autostop,
      /SAMPLE_ATTEMPTS/,
      stop(
        "The bounced-rows read retries while the ledger lags (D141; the D140 first run bailed in the same second).",
        "campaignBounceAutostop.ts reads the ledger once and gives up again.",
      ),
    );
    // D148 — Josh: "i dont want anything paused anymore." A real burst is
    // investigated, remediated and re-queued; the campaign keeps running.
    assert.doesNotMatch(
      autostop,
      /updateCampaignStatus\([^)]*PAUSED/,
      stop(
        "The bounce loop never pauses a campaign (D148, Josh 2026-08-27).",
        "campaignBounceAutostop.ts writes PAUSED again — that reverses D148 and needs Josh.",
      ),
    );
    assert.doesNotMatch(
      autostop,
      /markBouncePaused/,
      stop(
        "No new pause stamps — the loop only drains pre-D148 stamps (D148).",
        "campaignBounceAutostop.ts stamps bounce pauses again.",
      ),
    );
    assert.doesNotMatch(
      autostop,
      /updateCampaignStatus\([^)]*START/,
      stop(
        "Pauses belong to humans in both directions (D40/D148).",
        "campaignBounceAutostop.ts STARTs a campaign again.",
      ),
    );
  });
});

describe("owner intent — D142 generic is a pool, pre-warmed is a grant", () => {
  it("D142: the two lists are separate; markers are generics; the POC re-point stays staged", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    // Pre-warmed is granted by Josh alone — the generic pool never implies it.
    assert.deepEqual(
      defaults.prewarmedDomains,
      ["crosslaunchco.com", "crossscaleco.com", "cleartechco.com"],
      stop(
        "Pre-warmed means only what Josh granted (D142).",
        `PREWARMED_DOMAINS default is now ${defaults.prewarmedDomains.join(",")}.`,
      ),
    );
    for (const domain of [
      "getintroducedapp.com",
      "appgetintroduced.com",
      "appquickconnectsales.com",
    ]) {
      assert.ok(
        defaults.extraGenericDomains.includes(domain) &&
          !defaults.prewarmedDomains.includes(domain),
        stop(
          "GetIntroduced/QuickConnect are generic pool, NOT pre-warmed (D142, Josh 2026-08-27).",
          `${domain} drifted out of the generic pool or into the pre-warmed grant.`,
        ),
      );
    }

    const { isPrewarmedGeneric } = await import("../services/warmupGate.js");
    assert.equal(
      isPrewarmedGeneric(
        { from_name: "Any Body" },
        "a@getintroducedapp.com",
        {
          extraGenericMailboxes: [],
          prewarmedDomains: defaults.prewarmedDomains,
        },
        { getPoolMailbox: () => undefined },
      ),
      false,
      stop(
        "A generic-pool domain does not skip the warmup clock (D142).",
        "isPrewarmedGeneric treats generic membership as a warmup exemption again.",
      ),
    );

    const { isGenericMailbox } = await import("../lib/clientInbox.js");
    assert.equal(
      isGenericMailbox(
        { client_id: 777, from_name: "Any Body" },
        "a@someclientdomain.com",
        {
          extraGenericMailboxes: [],
          extraGenericDomains: [],
          prewarmedDomains: [],
        },
        {
          getPoolMailbox: () => undefined,
          isMarkerClientId: (id: number | null | undefined) => id === 777,
        },
      ),
      true,
      stop(
        "A box assigned to the Generic/POC marker client is a generic (D142).",
        "isGenericMailbox no longer recognises marker-client ids.",
      ),
    );

    const oneClient = await read("../services/oneClientMembership.ts");
    assert.match(
      oneClient,
      /markerOwned/,
      stop(
        "A Generic/POC client_id is a deliberate assignment one-client must not rewrite (D142).",
        "oneClientMembership.ts reverts marker-owned boxes to the POC client again.",
      ),
    );

    const provisioner = await read("../services/poolProvisioner.ts");
    assert.match(
      provisioner,
      /new Set\(this\.config\.prewarmedDomains\)/,
      stop(
        "Pool registration of pre-warmed fleets reads PREWARMED_DOMAINS (D142).",
        "poolProvisioner.ts registers the whole generic pool as pre-warmed.",
      ),
    );

    // The staged half: mailbox-side POC ownership re-point is NOT live —
    // one-client still resolves the generic owner from the POC patterns.
    assert.match(
      oneClient,
      /pocClientId\(clients, this\.config\.pocClientNamePatterns\)/,
      stop(
        "The POC mailbox-owner re-point is a staged decision awaiting its own entry (D142).",
        "oneClientMembership.ts changed the generic owner source without a decision.",
      ),
    );
  });
});

describe("owner intent — D143 the gate must win or escalate", () => {
  it("D143: young boxes get no client_id; boomerangs are ledgered and briefed; pod-tags goes first", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    // The confident attach consults the warmup clock before writing —
    // a client_id on a 2-day-old box is what armed the external
    // re-adder on 2026-08-27.
    const audit = await read("../services/domainClientAudit.ts");
    assert.match(
      audit,
      /owesWarmup\(/,
      stop(
        "A box that owes warmup days is not attach supply (D143).",
        "domainClientAudit.ts writes client_id without consulting owesWarmup.",
      ),
    );

    const gate = await read("../services/warmupGate.ts");
    assert.match(
      gate,
      /recordWarmupGatePull/,
      stop(
        "Every gate pull is counted so external re-adds are visible (D143).",
        "warmupGate.ts no longer records pulls in the boomerang ledger.",
      ),
    );
    assert.match(
      gate,
      /warmupEnsuredRecently/,
      stop(
        "The warmup re-enable writes once per account per day, not per pull (D143).",
        "warmupGate.ts rewrites identical warmup settings on every pull again — 84 writes per pass during the 8/27 fight.",
      ),
    );

    const brief = await read("../services/clientDayBrief.ts");
    assert.match(
      brief,
      /listWarmupGateBoomerangs/,
      stop(
        "External re-adds are a human ask on the EOD brief (D143).",
        "clientDayBrief.ts no longer hands the boomerang ledger to Slack.",
      ),
    );

    // Pod-tags spends the fresh monitor rate window first: ninth in line
    // it 429'd three consecutive passes (00:22, 06:20, 12:17Z on 8/27)
    // even with spaced writes and retries:7.
    const index = await read("../index.ts");
    const monitorBody = index.slice(
      index.indexOf("monitorInFlight = (async () =>"),
    );
    const tagsAt = monitorBody.indexOf('stage("pod-tags"');
    const resultsAt = monitorBody.indexOf('stage("monitor-results"');
    assert.ok(
      tagsAt >= 0 && resultsAt >= 0 && tagsAt < resultsAt,
      stop(
        "Pod-tags runs before placement pulls in the monitor (D135/D143).",
        "index.ts runs pod-tags after monitor-results again.",
      ),
    );
  });

  it("D143: re-added inventory — pulls repeat, the warmup write does not, boomerang lists at three", async () => {
    const { StateStore } = await import("../state/store.js");
    const { WarmupGateService } = await import("../services/warmupGate.js");
    const state = new StateStore(
      `/tmp/dw-gate-boomerang-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const now = Date.now();
    const inventory = {
      campaigns: [{ id: 1, name: "Parlay One", status: "ACTIVE" }],
      accounts: [
        {
          id: 11,
          from_email: "young@newfleet.info",
          from_name: "Young Box",
          created_at: new Date(now - 2 * 86_400_000).toISOString(),
          campaign_ids: [1],
        },
        {
          id: 12,
          from_email: "old@newfleet.info",
          from_name: "Old Box",
          created_at: new Date(now - 60 * 86_400_000).toISOString(),
          campaign_ids: [1],
        },
      ],
      clients: [],
      fetchedAt: now,
    } as never;

    const removes: Array<{ campaignId: number; ids: number[] }> = [];
    let warmupWrites = 0;
    const smartlead = {
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removes.push({ campaignId, ids });
      },
      configureWarmup: async () => {
        warmupWrites += 1;
      },
      getEmailAccount: async () => {
        throw new Error("detail fetch not expected — created_at is present");
      },
      updateCampaignStatus: async () => {
        throw new Error("pause not expected — another sender remains");
      },
    } as never;
    const slack = { notifyWarmupGate: async () => {} } as never;

    const service = new WarmupGateService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      slack,
      state,
    );
    // The same inventory three passes running — exactly what an external
    // re-adder produces: the gate removed the box, something put it back.
    for (let pass = 0; pass < 3; pass += 1) {
      const result = await service.run({ inventory });
      assert.equal(
        result.removed,
        1,
        stop(
          "The gate keeps pulling a re-added under-warmed box (D105/D143).",
          `pass ${pass + 1} removed ${result.removed}.`,
        ),
      );
    }
    assert.deepEqual(
      removes.map((row) => row.ids),
      [[11], [11], [11]],
      stop(
        "Only the under-warmed box is pulled, every pass (D143).",
        "The gate stopped pulling, or pulled the warmed box.",
      ),
    );
    assert.equal(
      warmupWrites,
      1,
      stop(
        "One warmup re-enable per account per day (D143).",
        `configureWarmup ran ${warmupWrites} times across three pulls of the same box.`,
      ),
    );
    const boomerangs = state.listWarmupGateBoomerangs();
    assert.equal(
      boomerangs.length,
      1,
      stop(
        "Three pulls of one membership in 24h is a boomerang (D143).",
        `listWarmupGateBoomerangs returned ${boomerangs.length} row(s).`,
      ),
    );
    assert.equal(boomerangs[0]!.email, "young@newfleet.info");
    assert.equal(boomerangs[0]!.count, 3);
  });
});

describe("owner intent — D145/D146 a sender block is a burned domain", () => {
  it("D145/D146: 5.1.8 classifies sender_blocked and opens the retire ask, never waiting for dominance", async () => {
    const { classifyBounceText } = await import("../lib/bounceReason.js");
    assert.equal(
      classifyBounceText(
        "550 5.1.8 Access denied, bad outbound sender AS(42004)",
      ),
      "sender_blocked",
      stop(
        "A 5.1.8 outbound-spam block is the SENDER flagged, not a bad recipient (D145).",
        "classifyBounceText files 5.1.8 as something else again — on 8/27 that hid a live Microsoft block behind 'invalid_recipient'.",
      ),
    );

    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );
    const autostop = await read("../services/campaignBounceAutostop.ts");
    assert.match(
      autostop,
      /sample\.bounceClass === "sender_blocked"/,
      stop(
        "The sender-block trigger reads the SAMPLES, never the dominant class (D145) — a minority 5.1.8 under a tenant-cap wave still acts.",
        "campaignBounceAutostop.ts gates the sender-block response on the dominant verdict again.",
      ),
    );
    // D146 — Josh: "that bad outbound sender should just trigger a burned
    // domain." The response is the standard retire ask (tap = approval),
    // not an FYI page.
    assert.match(
      autostop,
      /requestIsolationAction/,
      stop(
        "A sender block feeds the burned-domain flow (D146).",
        "campaignBounceAutostop.ts no longer opens an isolation action for a blocked sender.",
      ),
    );
    assert.match(
      autostop,
      /kind: "retire_domain"/,
      stop(
        "The blocked sender's domain gets the standard retire ask with buttons (D146/D49).",
        "campaignBounceAutostop.ts downgraded the sender-block response to something other than the retire_domain ask.",
      ),
    );
  });
});

describe("owner intent — D147 a remediated bounce is a resend", () => {
  it("D147: the resend is NDR-gated, once per lead, suppression-respecting, never lead sourcing", async () => {
    const { RESURRECTABLE_CLASSES } = await import(
      "../services/bounceResurrection.js"
    );
    assert.deepEqual(
      [...RESURRECTABLE_CLASSES].sort(),
      ["content_block", "sender_blocked", "tenant_rate_limit"],
      stop(
        "Only sender-fault bounces come back — a bad address stays dead (D147, Josh: 'inbox rate level or a copy problem we solve').",
        "RESURRECTABLE_CLASSES changed; resending invalid recipients is a fresh hard bounce on purpose.",
      ),
    );

    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );
    const service = await read("../services/bounceResurrection.ts");
    assert.match(
      service,
      /ndrBodyFromHistory/,
      stop(
        "Each lead's OWN bounce reason gates its resend (D147).",
        "bounceResurrection.ts no longer re-reads the per-lead NDR before re-queueing.",
      ),
    );
    assert.match(
      service,
      /wasLeadResurrected/,
      stop(
        "One resurrection per lead per campaign — a recurring cap must not become a resend loop (D147).",
        "bounceResurrection.ts lost the once-per-lead ledger check.",
      ),
    );
    assert.doesNotMatch(
      service,
      /addLeadsToCampaign/,
      stop(
        "Resurrection re-sends leads Josh already imported via restoreCampaignLead; the shell-only import helper stays shell-only (D147/D52/D118).",
        "bounceResurrection.ts calls addLeadsToCampaign.",
      ),
    );

    const client = await read("../clients/smartlead.ts");
    assert.match(
      client,
      /restoreCampaignLead[\s\S]{0,900}ignore_global_block_list: false/,
      stop(
        "A re-queued lead still honors the block list (D147).",
        "restoreCampaignLead ignores the global block list.",
      ),
    );
    assert.match(
      client,
      /restoreCampaignLead[\s\S]{0,900}ignore_unsubscribe_list: false/,
      stop(
        "Someone who unsubscribed since import stays out (D147).",
        "restoreCampaignLead ignores the unsubscribe list.",
      ),
    );

    // D148 moved the trigger: the burst itself opens the incident — with
    // no pause there is no restart to wait for. The stamp-drain hook
    // still owes the resend for pre-D148 pauses a human STARTs.
    const autostop = await read("../services/campaignBounceAutostop.ts");
    assert.match(
      autostop,
      /noteIncident/,
      stop(
        "A sender-fault burst opens the resurrection incident on the spot (D147/D148).",
        "campaignBounceAutostop.ts no longer opens the incident from the burst verdict.",
      ),
    );
    assert.match(
      autostop,
      /isBouncePaused\?\?*\.?\(?.{0,20}campaign\.id\)?[\s\S]{0,400}noteRestart/,
      stop(
        "A pre-D148 stamped pause a human STARTs still owes its resend (D147).",
        "campaignBounceAutostop.ts dropped the stamp-drain hook while old stamps may remain.",
      ),
    );
  });
});

describe("owner intent — D148 nothing pauses: investigate, remediate, re-add", () => {
  it("D148: the remediation gates decide the resend — cap reset, resolved retire ask, edited copy", async () => {
    const { tenantGateOpen } = await import("../services/bounceResurrection.js");
    assert.equal(
      tenantGateOpen(
        "2026-08-27T15:00:00.000Z",
        Date.parse("2026-08-27T23:59:00Z"),
      ),
      false,
      stop(
        "A capped lead never resends into the same exhausted cap (D148).",
        "tenantGateOpen opens on the bounce's own UTC day — that is a guaranteed re-bounce and burns the lead's one resend.",
      ),
    );
    assert.equal(
      tenantGateOpen(
        "2026-08-27T15:00:00.000Z",
        Date.parse("2026-08-28T00:10:00Z"),
      ),
      true,
      stop(
        "Midnight UTC resets the tenant cap — the resend goes out then (D148).",
        "tenantGateOpen stays shut after the cap reset; capped leads would expire unsent.",
      ),
    );

    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );
    const service = await read("../services/bounceResurrection.ts");
    assert.match(
      service,
      /status === "pending"/,
      stop(
        "A blocked sender's leads wait for its retire ask to be resolved (D148/D146).",
        "bounceResurrection.ts no longer consults the pending retire ask before resending.",
      ),
    );
    assert.match(
      service,
      /fetchCampaignSequences/,
      stop(
        "Content-blocked leads resend only after the copy actually changed (D148).",
        "bounceResurrection.ts no longer reads the sequence edit stamp — unchanged copy would re-bounce on purpose.",
      ),
    );
    assert.match(
      service,
      /DEFER_EXPIRY_MS/,
      stop(
        "A gate that never opens expires and is reported, never held forever (D148).",
        "bounceResurrection.ts lost the 7-day deferral expiry.",
      ),
    );
    assert.match(
      service,
      /sweepOrphanVerdicts/,
      stop(
        "A fresh sender-fault verdict with no incident re-opens — a deploy race cannot eat a resend (D148).",
        "bounceResurrection.ts lost the orphan-verdict sweep; the 8/27 stale-branch deploy would have silently forfeited four campaigns' resends.",
      ),
    );
    assert.match(
      service,
      /requestIsolationAction/,
      stop(
        "A 5.1.8 found during the incident re-scan opens the same retire ask a burst sample would (D146/D148) — the 8/27 live block was classified pre-D146 and the burst path never saw it.",
        "bounceResurrection.ts no longer opens the burned-domain ask from the scan; a scan-discovered block would resend with no ask to gate it.",
      ),
    );

    const autostop = await read("../services/campaignBounceAutostop.ts");
    assert.match(
      autostop,
      /burstReceiptText/,
      stop(
        "The burst receipt IS the investigation Josh asked for — what bounced, why, what happens next (D148).",
        "campaignBounceAutostop.ts no longer Slacks the burst finding; with no pause and no receipt a burst would be invisible.",
      ),
    );
    assert.match(
      autostop,
      /BURST_REALERT_MS/,
      stop(
        "A still-burning wave folds into its open incident — one receipt an hour, not one per tick (D148).",
        "campaignBounceAutostop.ts lost the burst fold-in cooldown.",
      ),
    );
  });
});

describe("owner intent — D149 alerts and watches live on Railway", () => {
  it("D149: ops_alert is an allowed Slack kind", async () => {
    const { slackAllowed } = await import("../lib/slackAllow.js");
    assert.equal(
      slackAllowed("ops_alert"),
      true,
      stop(
        "The machine pages its own anomalies to Slack instead of waiting for someone to read the logs (D149).",
        "slackAllowed('ops_alert') is false — stage-watchdog and deploy-identity pages are being quiet-dropped.",
      ),
    );
  });

  it("D149: one overdue judgement, and the health pass pages it", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );

    const index = await read("../index.ts");
    assert.match(
      index,
      /overdueStages\(/,
      stop(
        "The log scoreboard and the Slack pager share one overdue judgement (D149).",
        "index.ts no longer uses overdueStages for the scoreboard.",
      ),
    );
    assert.doesNotMatch(
      index,
      /const STAGE_OVERDUE_MS/,
      stop(
        "There is exactly one overdue judgement, in src/lib/stageWindows.ts (D149).",
        "index.ts grew its own overdue window again — the pager and the log can now disagree.",
      ),
    );
    assert.match(
      index,
      /alertStageAnomalies/,
      stop(
        "The health pass pages stage anomalies to Slack (D149).",
        "index.ts no longer calls alertStageAnomalies — the watch fell back to logs someone must come read.",
      ),
    );

    const ops = await read("../services/opsAlerts.ts");
    assert.match(
      ops,
      /"ops_alert"/,
      stop(
        "Stage pages carry the ops_alert kind (D149).",
        "opsAlerts.ts sends unclassified — slack-quiet drops it silently.",
      ),
    );
    assert.match(
      ops,
      /setStageAlert/,
      stop(
        "One page per overdue episode, stamped in state (D149).",
        "opsAlerts.ts no longer stamps episodes — it would page every 15 minutes.",
      ),
    );
  });

  it("D149: overdue judgement honours per-stage cadence and event-driven stages", async () => {
    const { overdueStages, STAGE_OVERDUE_WINDOWS_MS } = await import(
      "../lib/stageWindows.js"
    );
    assert.equal(
      STAGE_OVERDUE_WINDOWS_MS["pod-cover"],
      null,
      stop(
        "pod-cover is event-driven and never overdue (D131).",
        "The registry lost pod-cover's null window.",
      ),
    );
    const now = Date.now();
    const rows = overdueStages(
      {
        "dns-audit": {
          lastOkAt: new Date(now - 8 * 3600 * 1000).toISOString(),
          consecutiveFailures: 1,
          lastError: "HTTP 429",
        },
        "pod-cover": { lastOkAt: null, consecutiveFailures: 5, lastError: "boom" },
        reconnect: {
          lastOkAt: new Date(now - 60 * 1000).toISOString(),
          consecutiveFailures: 0,
          lastError: null,
        },
      },
      now,
    );
    assert.deepEqual(
      rows.map((r) => r.name),
      ["dns-audit"],
      stop(
        "A 6-hour stage silent for 8h is overdue; an event-driven stage never is; a fresh stage is not (D131/D149).",
        "overdueStages misjudged the registry windows.",
      ),
    );
  });

  it("D149: boot reads its own deploy identity and pages when it is wrong", async () => {
    const read = (path: string) =>
      import("node:fs/promises").then((fs) =>
        fs.readFile(new URL(path, import.meta.url), "utf8"),
      );
    const index = await read("../index.ts");
    assert.match(
      index,
      /readDeployIdentity/,
      stop(
        "Boot logs which build is live (D149).",
        "index.ts no longer reads the deploy identity at boot.",
      ),
    );
    assert.match(
      index,
      /deployIdentityProblem/,
      stop(
        "A metadata-less or non-main build pages Slack at boot (D149).",
        "index.ts no longer checks the deploy identity for problems.",
      ),
    );
    const lib = await read("../lib/deployIdentity.ts");
    assert.match(
      lib,
      /RAILWAY_GIT_COMMIT_SHA/,
      stop(
        "Identity comes from Railway's injected git metadata (D149).",
        "deployIdentity.ts stopped reading RAILWAY_GIT_COMMIT_SHA.",
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
      /activeHoldUntilDate\(tagNames\(account\)\)/,
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

describe("owner intent — D107/D111 retired by D144: old-client teardown is gone", () => {
  it("D144: oldClientTeardown.ts does not exist", async () => {
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(new URL("../services/oldClientTeardown.ts", import.meta.url)),
      stop(
        "Old-client teardown is retired so restores are not re-deleted (D144).",
        "oldClientTeardown.ts exists again — D107/D111 delete gun is back.",
      ),
    );
  });

  it("D144: health no longer runs an old-client stage", async () => {
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../index.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(
      index,
      /OldClientTeardownService|stage\("old-client"/,
      stop(
        "Health must not delete Nieto / MSRS / Positive campaigns (D144).",
        "index.ts wired old-client teardown back into the health pass.",
      ),
    );
  });

  it("D144: OLD_CLIENT_CAMPAIGN_IDS config knob is gone", () => {
    assert.equal(
      "oldClientCampaignIds" in defaults,
      false,
      stop(
        "The teardown id list is gone with the teardown (D144).",
        "oldClientCampaignIds is back on AppConfig.",
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

describe("owner intent — D111 superseded by D144", () => {
  it("D111: retry-delete machinery is gone (D144)", async () => {
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(new URL("../services/oldClientTeardown.ts", import.meta.url)),
      stop(
        "D111's retry delete is retired with the teardown (D144).",
        "oldClientTeardown.ts exists again.",
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

describe("owner intent — D124/D157 Smartlead autopause: from force-off to dead field", () => {
  it("D157: the API field is handler-discarded — nothing writes it, and the code says why", async () => {
    const { readFile } = await import("node:fs/promises");
    const decisions = await readFile(
      new URL("../../DECISIONS.md", import.meta.url),
      "utf8",
    );
    assert.match(
      decisions,
      /## D124 — Force Smartlead bounce autopause off once/,
      stop(
        "Josh called a one-shot force-off of Smartlead autopause (D124) — history stays in the ledger.",
        "DECISIONS.md no longer has D124.",
      ),
    );
    assert.match(
      decisions,
      /## D157 /,
      stop(
        "The dead-field finding is in the ledger (D157).",
        "DECISIONS.md no longer has D157.",
      ),
    );
    // D157 — every generation of API "off" write (100, GET-echo, null) was
    // a no-op: POST /campaigns/{id}/settings validates
    // bounce_autopause_threshold and then discards it. A "banana" write
    // returned ok:true and the UI kept its value (2026-08-31, Peterson
    // campaign still at 7% after fleet-wide writes). No write may return.
    const autostop = await readFile(
      new URL("../services/campaignBounceAutostop.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      autostop,
      /bounce_autopause_threshold:/,
      stop(
        "No code writes bounce_autopause_threshold — the API discards it (D157).",
        "campaignBounceAutostop.ts builds an autopause write body again.",
      ),
    );
    assert.match(
      autostop,
      /UI-only|handler then DISCARDS/,
      stop(
        "The file says why there is no write: the field is UI-only (D157).",
        "campaignBounceAutostop.ts lost the D157 explanation — the next reader will re-add the dead write.",
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
    const settingsLib = await readFile(
      new URL("../lib/bounceAutopause.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      settingsLib,
      /"bounce_autopause_threshold"/,
      stop(
        "The settings echo list no longer carries the dead field (D157).",
        "lib/bounceAutopause.ts echoes bounce_autopause_threshold again.",
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
    // (The autostop pause-stamp pin retired with the pause itself — D148:
    // the loop never pauses, so there is nothing new to stamp. qa-unpause
    // keeps consulting the stamp while pre-D148 stamps drain.)
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
    // Both roads into stageHealth: the stage() wrapper AND direct
    // recordStageOk calls (the health-pass umbrella slipped this net once —
    // its record was pruned as a ghost on every deploy).
    const staged = [
      ...[...index.matchAll(/stage\("([a-z0-9-]+)"/g)].map((m) => m[1]),
      ...[...index.matchAll(/recordStageOk\("([a-z0-9-]+)"/g)].map((m) => m[1]),
    ];
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

describe("owner intent — D133/D134 the taps act fleet-wide", () => {
  it("D133: the word tap sweeps every ACTIVE campaign; D134: retire approves the backfill", async () => {
    const { readFile } = await import("node:fs/promises");
    const exec = await readFile(
      new URL("../services/isolationExecute.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      exec,
      /sequenceContainsWord/,
      stop(
        "One tap fixes the word on every ACTIVE campaign carrying it (D133).",
        "isolationExecute.ts went back to a single-campaign swap.",
      ),
    );
    assert.doesNotMatch(
      exec,
      /pickSequence/,
      stop(
        "The fleet-wide swap edits every step that carries the word (D133).",
        "isolationExecute.ts picks a single sequence again.",
      ),
    );
    assert.match(
      exec,
      /approveGenericBackfill/,
      stop(
        "A retire tap doubles as the generic-backfill approval for the campaigns it cut (D134).",
        "isolationExecute.ts retires without covering the volume.",
      ),
    );
    assert.match(
      exec,
      /retire:\$\{domain\}/,
      stop(
        "Backfill approvals record which retire granted them (D134).",
        "isolationExecute.ts lost the retire provenance on approvals.",
      ),
    );
    assert.match(
      exec,
      /platformsMatchingEspMix|espMixFromAccountTypes/,
      stop(
        "A retire tap buys an ESP-matched replacement in the same swoop (D150).",
        "isolationExecute.ts retires without matching ESPs on the buy.",
      ),
    );
    assert.match(
      exec,
      /this\.buy\.run/,
      stop(
        "A retire tap runs the replacement buy — Josh's tap is the spend approval (D150).",
        "isolationExecute.ts no longer buys on retire.",
      ),
    );
    const actions = await readFile(
      new URL("../lib/isolationActions.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      actions,
      /one pending ask per word/,
      stop(
        "One pending ask per word — the tap covers the fleet (D133).",
        "isolationActions.ts dedupes word swaps per campaign again.",
      ),
    );
  });
});

describe("owner intent — D151 word hunt rides a paused shell", () => {
  it("D151: copy isolation schedules off the word-hunt shell mapping", async () => {
    const { readFile } = await import("node:fs/promises");
    const copy = await readFile(
      new URL("../services/copyIsolation.ts", import.meta.url),
      "utf8",
    );
    const shell = await readFile(
      new URL("../lib/wordHuntShell.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      shell,
      /WORD_HUNT_SHELL_NAME|ensureWordHuntShell/,
      stop(
        "Word hunt has a paused shell helper like canaries (D151).",
        "wordHuntShell.ts is missing.",
      ),
    );
    assert.match(
      shell,
      /writeWordHuntVariantSequences/,
      stop(
        "Word hunt writes every deletion as its own shell sequence step (D151).",
        "wordHuntShell.ts lost the parallel multi-seq write.",
      ),
    );
    assert.match(
      copy,
      /writeWordHuntVariantSequences/,
      stop(
        "Copy isolation arms the word-hunt shell before scheduling (D151).",
        "copyIsolation.ts went back to sequence-only manual posts.",
      ),
    );
    assert.match(
      copy,
      /Promise\.all/,
      stop(
        "Word-hunt placements fire in parallel once the shell sequences exist (D151).",
        "copyIsolation.ts schedules deletions serially again.",
      ),
    );
    assert.match(
      copy,
      /resolveProviderIds/,
      stop(
        "Word-hunt placements resolve provider_ids (D151).",
        "copyIsolation.ts no longer resolves providers.",
      ),
    );
  });

  it("D151: word-hunt Slack progress uses copy_word so completion is not quiet-dropped", async () => {
    const { readFile } = await import("node:fs/promises");
    const slack = await readFile(
      new URL("../clients/slack.ts", import.meta.url),
      "utf8",
    );
    const block = slack.slice(
      slack.indexOf("async notifyCopyIsolation"),
      slack.indexOf("async notifyPodControls"),
    );
    assert.match(
      block,
      /"copy_word"/,
      stop(
        "notifyCopyIsolation must send as copy_word or D71 drops hunt completion (D151).",
        "slack.ts notifyCopyIsolation still posts unclassified.",
      ),
    );
  });

  it("D152: suggested swap keeps inboxing for gift-bait openers", async () => {
    const { readFile } = await import("node:fs/promises");
    const actions = await readFile(
      new URL("../lib/isolationActions.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      actions,
      /Air Pods|gift-bait|pen-test work/,
      stop(
        "Gift-bait openers get a substitute, not a blank delete (D152).",
        "suggestedCopySwap lost the Air Pods / gift-bait branch.",
      ),
    );
    const proof = await readFile(
      new URL("../lib/isolationProof.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      proof,
      /keeps the line/,
      stop(
        "The Make the changes proof says the edit keeps the line's job (D152).",
        "copySwapProof still only says delete.",
      ),
    );
  });

  it("D153: Write my own edit button opens a modal that names the find phrase", async () => {
    const { readFile } = await import("node:fs/promises");
    const slack = await readFile(
      new URL("../clients/slack.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      slack,
      /Write my own edit/,
      stop(
        "swap_copy Slack ask offers Write my own edit (D153).",
        "notifyIsolationAction lost the custom-edit button.",
      ),
    );
    assert.match(
      slack,
      /SWAP_EDIT_ACTION_ID|isolation_swap_edit/,
      stop(
        "Write my own edit is a native interactive button (D153).",
        "slack.ts no longer wires isolation_swap_edit.",
      ),
    );
    assert.match(
      slack,
      /openSwapEditModal|views\.open|viewsOpen/,
      stop(
        "Custom edit opens a Slack modal via views.open (D153).",
        "SlackClient lost viewsOpen / openSwapEditModal.",
      ),
    );
    const modal = await readFile(
      new URL("../lib/slackSwapEdit.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      modal,
      /Replacing this exact phrase\/word/,
      stop(
        "The edit modal labels the exact find phrase (D153).",
        "slackSwapEdit.ts lost the Replacing this exact phrase/word label.",
      ),
    );
    const index = await readFile(
      new URL("../index.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      index,
      /view_submission/,
      stop(
        "/slack/interactions handles the edit modal submit (D153).",
        "index.ts interactions handler has no view_submission branch.",
      ),
    );
    assert.match(
      index,
      /decision === "edit"|parsed\.decision === "edit"/,
      stop(
        "/slack/interactions opens the modal on the edit button (D153).",
        "index.ts interactions handler does not branch on edit.",
      ),
    );
  });
});

describe("owner intent — D135/D136 fleet visibility", () => {
  it("D135: POD tags converge from the shared pods; D136: domain-client mismatches are advisory only", async () => {
    const { readFile } = await import("node:fs/promises");
    const tags = await readFile(
      new URL("../services/podTags.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      tags,
      /loadPods\(/,
      stop(
        "POD tags come from the same A/B pods the rest system computes (D135).",
        "podTags.ts derives pods on its own.",
      ),
    );
    assert.match(
      tags,
      /POD_TAG_A|"POD-A"/,
      stop(
        "The A/B rest split is visible in Smartlead as POD-A/POD-B tags (D135).",
        "podTags.ts lost the tag converge.",
      ),
    );
    const audit = await readFile(
      new URL("../services/domainClientAudit.ts", import.meta.url),
      "utf8",
    );
    // D142 amended D136: a CONFIDENT match (exactly one client token in
    // the domain base, or a generic-fleet orphan → the Generic marker)
    // attaches; everything else is still an advisory, never a guess.
    assert.match(
      audit,
      /confidentClientForDomain/,
      stop(
        "Attaches happen only through the confident matcher (D142).",
        "domainClientAudit.ts writes client ids without the confident gate.",
      ),
    );
    assert.match(
      audit,
      /account\.client_id == null/,
      stop(
        "A box already carrying a real client_id is never rewritten by the audit (D142 — the POC re-point is a staged decision, not this pass).",
        "domainClientAudit.ts overwrites existing client assignments.",
      ),
    );
    assert.doesNotMatch(
      audit,
      /kind: "split_clients"[\s\S]{0,400}updateEmailAccount/,
      stop(
        "split_clients is always a human question (D136/D142).",
        "domainClientAudit.ts writes on a split-clients domain.",
      ),
    );
    assert.match(
      audit,
      /setDomainAdvisories/,
      stop(
        "Domain-client mismatches surface on the EOD brief (D136).",
        "domainClientAudit.ts no longer persists advisories.",
      ),
    );
  });
});

describe("owner intent — D137 the rig arms through the approval flow", () => {
  it("D137: an unarmed rig asks once; the buy stamps the state domain; config still overrides", async () => {
    const { readFile } = await import("node:fs/promises");
    const rig = await readFile(
      new URL("../services/isolationRig.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      rig,
      /buy_isolation_domain/,
      stop(
        "An unarmed word-hunt rig requests its domain buy through the approval flow (D137).",
        "isolationRig.ts silently skips when unarmed again.",
      ),
    );
    assert.match(
      rig,
      /effectiveIsolationDomain/,
      stop(
        "The rig reads ISOLATION_DOMAIN or the state record the buy stamped (D137).",
        "isolationRig.ts reads only the env var again.",
      ),
    );
    const exec = await readFile(
      new URL("../services/isolationExecute.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      exec,
      /buyIsolationDomain/,
      stop(
        "Josh's tap buys the isolation domain and arms the rig (D137).",
        "isolationExecute.ts lost the buy_isolation_domain path.",
      ),
    );
    const actors = await readFile(
      new URL("../lib/isolationActors.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      actors,
      /buy_isolation_domain/,
      stop(
        "The isolation-domain buy is owner-only spend (D4/D137).",
        "isolationActors.ts no longer knows the kind.",
      ),
    );
  });
});

describe("owner intent — D138 the campaign min gap is converged", () => {
  it("D138: an ACTIVE campaign below the 10-minute gap is written back on sight", async () => {
    const { readFile } = await import("node:fs/promises");
    const check = await readFile(
      new URL("../services/campaignCheck.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      check,
      /min_time_btwn_emails/,
      stop(
        "The checker converges campaign-level min_time_btwn_emails to the gap floor (D138).",
        "campaignCheck.ts stopped guarding the campaign-level gap.",
      ),
    );
    assert.match(
      check,
      /campaign_min_gap/,
      stop(
        "A failed gap write stays visible as a campaign_min_gap finding (D138).",
        "campaignCheck.ts hides gap-converge failures.",
      ),
    );
  });
});

describe("owner intent — D139 staffing honors the warmup clock", () => {
  it("D139: fan-out and top-up refuse inboxes that owe warmup days", async () => {
    const { readFile } = await import("node:fs/promises");
    const gate = await readFile(
      new URL("../services/warmupGate.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      gate,
      /export function owesWarmup/,
      stop(
        "One shared clock decides who owes warmup — the gate's own (D139).",
        "warmupGate.ts lost the owesWarmup helper.",
      ),
    );
    const fanOut = await readFile(
      new URL("../services/clientFanOut.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      fanOut,
      /owesWarmup/,
      stop(
        "Fan-out must not re-staff the inboxes the gate just pulled (D139).",
        "clientFanOut.ts fans under-warmed inboxes out again.",
      ),
    );
    const topUp = await readFile(
      new URL("../services/campaignTopUp.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      topUp,
      /owesWarmup/,
      stop(
        "Top-up supply that owes warmup days is not supply (D139).",
        "campaignTopUp.ts staffs under-warmed pool inboxes again.",
      ),
    );
    const clientRest = await readFile(
      new URL("../services/clientRest.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      clientRest,
      /owesWarmup/,
      stop(
        "Client A/B on-week restore must not re-staff under-warmed inboxes (D139/D154).",
        "clientRest.ts restores under-warmed boxes onto every ACTIVE client campaign again.",
      ),
    );
    const slack = await readFile(
      new URL("../clients/slack.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      slack,
      /need 14|14-day warmup/,
      stop(
        "The pull notice states the real owed days from config (D139).",
        "slack.ts hardcodes a stale 14-day warmup again.",
      ),
    );
  });
});

describe("owner intent — D140 bounce reasons are read, not guessed", () => {
  it("D140: a bounce burst classifies the SMTP reasons; a tenant cap alerts once per day", async () => {
    const { readFile } = await import("node:fs/promises");
    const lib = await readFile(
      new URL("../lib/bounceReason.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      lib,
      /5\\\.7\\\.233|tenant external recipient rate limit/,
      stop(
        "The classifier knows Microsoft's tenant daily cap (D140).",
        "bounceReason.ts lost the tenant-rate-limit class.",
      ),
    );
    const loop = await readFile(
      new URL("../services/campaignBounceAutostop.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      loop,
      /classifyRecentBounces/,
      stop(
        "A bounce burst reads the actual SMTP reasons before anyone blames the list (D140).",
        "campaignBounceAutostop.ts acts blind again.",
      ),
    );
    assert.match(
      loop,
      /tenant-limit:\$\{domain\}/,
      stop(
        "A tenant hitting its cap alerts Josh once per tenant per day (D140).",
        "campaignBounceAutostop.ts lost the tenant alert dedupe.",
      ),
    );
  });
});

describe("owner intent — D158 ugly same-ESP starts isolation", () => {
  it("D158: canary/live placement under 80% queues isolation; placement Slack stays quiet", async () => {
    const { readFile } = await import("node:fs/promises");
    const branch = await readFile(
      new URL("../services/isolationBranch.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      branch,
      /queueUglyPlacementSuspects/,
      stop(
        "Same-ESP under 80% on canary-copy or live placement queues isolation (D158).",
        "isolationBranch.ts no longer scans placement/canary scores.",
      ),
    );
    assert.match(
      branch,
      /campaignInSpam: true/,
      stop(
        "Queued placement suspects evaluate as campaign-in-spam so COPY vs INFRA can run (D158).",
        "isolationBranch.run() no longer passes campaignInSpam: true.",
      ),
    );
    assert.match(
      branch,
      /queueContentBlockSuspect/,
      stop(
        "Dominant bounce content_block queues isolation (D158).",
        "isolationBranch.ts lost queueContentBlockSuspect.",
      ),
    );
    assert.match(
      branch,
      /ensureArmed/,
      stop(
        "COPY with an unarmed rig asks to arm once (D158/D137).",
        "isolationBranch.ts no longer calls ensureArmed on a waiting COPY.",
      ),
    );
    assert.match(
      branch,
      /verdict === "COPY"/,
      stop(
        "COPY starts teardown (or waits) instead of leaving teardownStarted false (D158).",
        "isolationBranch.ts no longer starts teardown on every COPY verdict.",
      ),
    );
    const monitor = await readFile(
      new URL("../services/resultMonitor.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      monitor,
      /markCopySuspect/,
      stop(
        "ResultMonitor queues copy suspects from ugly same-ESP scores (D158).",
        "resultMonitor.ts no longer marks copy suspects.",
      ),
    );
    assert.match(
      monitor,
      /listCopyCanaryTestIds/,
      stop(
        "ResultMonitor always tracks isolation.copyCanaries test ids (D158).",
        "resultMonitor.ts no longer includes copyCanaries.*.testId.",
      ),
    );
    assert.doesNotMatch(
      monitor,
      /notifyPlacementResult/,
      stop(
        "ResultMonitor must not pretend to Slack a placement page (D71/D158).",
        "resultMonitor.ts still calls notifyPlacementResult.",
      ),
    );
    const bounce = await readFile(
      new URL("../services/campaignBounceAutostop.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      bounce,
      /queueContentBlockSuspect/,
      stop(
        "Bounce loop queues isolation on dominant content_block (D158).",
        "campaignBounceAutostop.ts no longer calls queueContentBlockSuspect.",
      ),
    );
    const automated = await readFile(
      new URL("../clients/smartdelivery.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      automated,
      /isCanaryCopyTestName/,
      stop(
        "Canary copy: counts as an automated test (D158).",
        "isAutomatedTest no longer treats Canary copy: as automated.",
      ),
    );
    const slack = await readFile(
      new URL("../clients/slack.ts", import.meta.url),
      "utf8",
    );
    const placementFn = slack.slice(slack.indexOf("async notifyPlacementResult"));
    const sendInPlacement = placementFn
      .slice(0, placementFn.indexOf("\n  async ") === -1 ? placementFn.length : placementFn.indexOf("\n  async "))
      .includes("this.send(");
    assert.equal(
      sendInPlacement,
      false,
      stop(
        "notifyPlacementResult does not post — isolation is the remediation (D71/D158).",
        "notifyPlacementResult still calls send().",
      ),
    );
    const decisions = await readFile(
      new URL("../../DECISIONS.md", import.meta.url),
      "utf8",
    );
    assert.match(
      decisions,
      /## D158 /,
      stop(
        "The AirPods miss is in the ledger (D158).",
        "DECISIONS.md no longer has D158.",
      ),
    );
  });
});

describe("owner intent — D159 isolation on-ramp is the 15-minute sweep", () => {
  it("D159: isolation-branch runs on health; /health names ugly-without-isolation", async () => {
    const { readFile } = await import("node:fs/promises");
    const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    const healthBody = index.slice(
      index.indexOf("const runHealth = async"),
      index.indexOf("const runBounceAutostop"),
    );
    assert.match(
      healthBody,
      /stage\("isolation-branch"/,
      stop(
        "The isolation on-ramp runs on the 15-minute health sweep (D159).",
        "index.ts no longer stages isolation-branch inside runHealth.",
      ),
    );
    const monitorBody = index.slice(
      index.indexOf("monitorInFlight = (async () =>"),
      index.indexOf("if (!cron.validate(config.cronScan))"),
    );
    assert.doesNotMatch(
      monitorBody,
      /stage\("isolation-branch"/,
      stop(
        "The 15-minute health sweep owns isolation-branch, not the 6-hour monitor (D159).",
        "index.ts still stages isolation-branch inside the monitor loop.",
      ),
    );
    assert.match(
      index,
      /placementIsolation/,
      stop(
        "/health exposes canaries/campaigns under 80% with no open isolation (D159).",
        "index.ts /health lost placementIsolation.",
      ),
    );
    const { STAGE_OVERDUE_WINDOWS_MS } = await import("../lib/stageWindows.js");
    assert.equal(
      STAGE_OVERDUE_WINDOWS_MS["isolation-branch"],
      45 * 60 * 1000,
      stop(
        "isolation-branch overdue window matches the 15-minute sweep (D159).",
        `isolation-branch window is ${STAGE_OVERDUE_WINDOWS_MS["isolation-branch"]}.`,
      ),
    );
    const canon = await readFile(new URL("../../CANON.md", import.meta.url), "utf8");
    assert.match(
      canon,
      /D159/,
      stop(
        "CANON still names the 15-minute on-ramp (D159).",
        "CANON.md lost D159.",
      ),
    );
    const decisions = await readFile(
      new URL("../../DECISIONS.md", import.meta.url),
      "utf8",
    );
    assert.match(
      decisions,
      /## D159 /,
      stop(
        "The 15-minute on-ramp cadence is in the ledger (D159).",
        "DECISIONS.md no longer has D159.",
      ),
    );
  });
});

describe("owner intent — D161 client-domain replace is client-named", () => {
  it("D161: retire/buy path refuses a generic spin for a client domain", async () => {
    const { readFile } = await import("node:fs/promises");
    const buy = await readFile(
      new URL("../services/isolationBuy.ts", import.meta.url),
      "utf8",
    );
    const exec = await readFile(
      new URL("../services/isolationExecute.ts", import.meta.url),
      "utf8",
    );
    const life = await readFile(
      new URL("../services/domainLifecycle.ts", import.meta.url),
      "utf8",
    );
    const lib = await readFile(
      new URL("../lib/retireReplacement.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      lib,
      /replacementParentForRetiredDomain/,
      stop(
        "Client-domain replace picks the client brand, not the generic parent (D161).",
        "retireReplacement.ts is missing.",
      ),
    );
    assert.match(
      lib,
      /isForbiddenGenericReplacement/,
      stop(
        "A generic spin is forbidden when the retired domain is a client domain (D161).",
        "retireReplacement.ts lost the refuse helper.",
      ),
    );
    assert.match(
      buy,
      /replacementParentForRetiredDomain/,
      stop(
        "The stock buy path derives the parent from the retired domain (D161).",
        "isolationBuy.ts still spins from isolationBuyParentDomain alone.",
      ),
    );
    assert.match(
      buy,
      /isForbiddenGenericReplacement/,
      stop(
        "The stock buy path refuses a generic candidate on a client retire (D161).",
        "isolationBuy.ts can still buy crosslaunchco* for a client domain.",
      ),
    );
    assert.match(
      exec,
      /replacementParentForRetiredDomain/,
      stop(
        "The D150 retire tap sets a client-brand parent (D161).",
        "isolationExecute.ts still hard-codes isolationBuyParentDomain on retire.",
      ),
    );
    assert.match(
      life,
      /replacementParentForRetiredDomain/,
      stop(
        "Buy-ahead and retire asks carry the client-brand parent (D161).",
        "domainLifecycle.ts still hard-codes isolationBuyParentDomain.",
      ),
    );
    const slack = await readFile(
      new URL("../clients/slack.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      slack,
      /never a generic\/pool spin, D161/,
      stop(
        "Slack retire copy names the client-named rule (D161).",
        "slack.ts retire copy lost D161.",
      ),
    );
    const canon = await readFile(
      new URL("../../CANON.md", import.meta.url),
      "utf8",
    );
    assert.match(
      canon,
      /MUST buy a client-named replacement/,
      stop(
        "CANON states the client-named replace MUST (D161).",
        "CANON.md lost the D161 MUST.",
      ),
    );
    assert.match(
      canon,
      /Canon as of \*\*D161\*\*/,
      stop(
        "CANON is as of D161.",
        "CANON.md header was not bumped.",
      ),
    );
    const decisions = await readFile(
      new URL("../../DECISIONS.md", import.meta.url),
      "utf8",
    );
    assert.match(
      decisions,
      /## D161 /,
      stop(
        "The client-named replace rule is in the ledger (D161).",
        "DECISIONS.md no longer has D161.",
      ),
    );
  });
});
