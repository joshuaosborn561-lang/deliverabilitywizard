import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CALLER_FOLLOWUP_BRIDGE_REMOVE_BY,
  CALLER_FOLLOWUP_BRIDGE_SENDERS,
  CALLER_FOLLOWUP_CAMPAIGN_IDS_DEFAULT,
  CALLER_FOLLOWUP_CAP_RAMP_TO,
  CALLER_FOLLOWUP_CAP_RAMP_YMD,
  CALLER_FOLLOWUP_DAYS_OF_WEEK,
  CALLER_FOLLOWUP_END_HOUR,
  CALLER_FOLLOWUP_HOME_CLIENT_ID,
  CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS,
  CALLER_FOLLOWUP_NAME_PREFIX_DEFAULT,
  CALLER_FOLLOWUP_OWNED_DOMAINS_BY_CAMPAIGN,
  CALLER_FOLLOWUP_SENDER_TAG_DEFAULT,
  CALLER_FOLLOWUP_START_HOUR,
  CALLER_FOLLOWUP_TIMEZONE,
  GABE_CALLS_DEEP_ROOTS_ID,
  GABE_CALLS_EMCOR_ID,
  GABE_CALLS_SALESGLIDER_ID,
  callerFollowUpAlertKey,
  callerFollowUpBridgeRemovalAlert,
  callerFollowUpBridgeShouldBeRemoved,
  callerFollowUpCampaignIdsFromSenders,
  callerFollowUpDesiredSignature,
  callerFollowUpForbidsStatusWrite,
  callerFollowUpHumanActionAlert,
  callerFollowUpMayAttach,
  callerFollowUpMustKeepEmptySignature,
  callerFollowUpMustKeepFromName,
  callerFollowUpMustKeepMessagePerDay,
  callerFollowUpMustPageBeforeAct,
  callerFollowUpMustSkipPodTags,
  callerFollowUpOwnedTargetCampaignId,
  callerFollowUpPolicyFromConfig,
  callerFollowUpScheduleHolds,
  callerFollowUpSkipsCanonMinGap,
  callerFollowUpSkipsEspMix,
  callerFollowUpSkipsRestCycle,
  callerFollowUpSkipsRunwayAndTopUpAlerts,
  callerFollowUpSkipsStaffingFloor,
  isCallerFollowUpBridgeSender,
  isCallerFollowUpCampaign,
  isCallerFollowUpCanonGapValue,
  isCallerFollowUpOwnedSeat,
  isCallerFollowUpSender,
  isCallerFollowUpSupplyBlocked,
} from "./callerFollowUp.js";

const tagged = { tags: [{ tag_name: "GABE-VM-RESERVED" }] };
const gabeCallsDeepRoots = {
  id: GABE_CALLS_DEEP_ROOTS_ID,
  name: "Gabe Calls | Deep Roots",
};
const regular = { id: 1, name: "SalesGlider Engagers" };

describe("CALLER FOLLOW-UP class (D242)", () => {
  it("rule identity: campaign ids or Gabe Calls | prefix, plus CALLER_FOLLOWUP tag", () => {
    assert.deepEqual(
      [...CALLER_FOLLOWUP_CAMPAIGN_IDS_DEFAULT],
      [4085158, 4085159, 4085160],
    );
    assert.equal(CALLER_FOLLOWUP_NAME_PREFIX_DEFAULT, "Gabe Calls |");
    assert.equal(CALLER_FOLLOWUP_SENDER_TAG_DEFAULT, "GABE-VM-RESERVED");
    assert.equal(isCallerFollowUpCampaign(gabeCallsDeepRoots), true);
    assert.equal(
      isCallerFollowUpCampaign({ id: 99, name: "Gabe Calls | New Caller" }),
      true,
    );
    assert.equal(
      isCallerFollowUpCampaign({ id: 99, name: "Post-call | Gabe | SalesGlider" }),
      false,
    );
    assert.equal(isCallerFollowUpCampaign(regular), false);
    assert.equal(isCallerFollowUpSender(tagged), true);
    assert.equal(isCallerFollowUpSender({ tags: [{ tag_name: "POD-A" }] }), false);
  });

  it("config can add another caller later", () => {
    const policy = callerFollowUpPolicyFromConfig({
      callerFollowUpCampaignIds: [9],
      callerFollowUpNamePrefix: "Ada Calls |",
      callerFollowUpSenderTag: "ADA-VM-RESERVED",
    });
    assert.equal(
      isCallerFollowUpCampaign({ id: 9, name: "Ada Calls | Acme" }, policy),
      true,
    );
    assert.equal(
      isCallerFollowUpCampaign({ id: 8, name: "Ada Calls | Acme" }, policy),
      true,
    );
    assert.equal(isCallerFollowUpCampaign(gabeCallsDeepRoots, policy), false);
    assert.equal(
      isCallerFollowUpSender({ tags: [{ tag_name: "ADA-VM-RESERVED" }] }, policy),
      true,
    );
    assert.equal(isCallerFollowUpSender(tagged, policy), false);
  });

  it("bridge senders are class senders even without the tag", () => {
    for (const row of CALLER_FOLLOWUP_BRIDGE_SENDERS) {
      assert.equal(isCallerFollowUpBridgeSender(row), true);
      assert.equal(isCallerFollowUpSender({ from_email: row.email, id: row.id }), true);
    }
    assert.equal(CALLER_FOLLOWUP_HOME_CLIENT_ID, 345263);
  });

  it("rule 1: signature stays empty — never apply or converge", () => {
    assert.equal(callerFollowUpDesiredSignature(), "");
    assert.equal(callerFollowUpMustKeepEmptySignature(tagged), true);
    assert.equal(
      callerFollowUpMustKeepEmptySignature({ tags: [{ tag_name: "POD-A" }] }),
      false,
    );
  });

  it("rule 2: from name stays as set — never rename", () => {
    assert.equal(callerFollowUpMustKeepFromName(tagged), true);
    assert.equal(
      callerFollowUpMustPageBeforeAct({ action: "rename", account: tagged }),
      true,
    );
  });

  it("rule 3: exclusive attach — only class boxes on class campaigns", () => {
    const other = {
      from_email: "harmony@salesglider.com",
      tags: [{ tag_name: "POD-A" }],
    };
    assert.equal(
      callerFollowUpMayAttach({
        account: { ...tagged, from_email: "gabriel@sorrelquotaio.co" },
        campaign: gabeCallsDeepRoots,
      }).ok,
      true,
    );
    assert.equal(
      callerFollowUpMayAttach({
        account: { ...tagged, from_email: "gabriel@sorrelquotaio.co" },
        campaign: regular,
      }).ok,
      false,
    );
    assert.equal(
      callerFollowUpMayAttach({ account: other, campaign: gabeCallsDeepRoots }).ok,
      false,
    );
    assert.equal(
      callerFollowUpMayAttach({ account: other, campaign: regular }).ok,
      true,
    );
    assert.equal(
      isCallerFollowUpSupplyBlocked(tagged, "gabriel@sorrelquotaio.co"),
      true,
    );
    assert.equal(
      isCallerFollowUpSupplyBlocked(
        { tags: [] },
        "gabe@gosalesglider.info",
      ),
      true,
    );
  });

  it("rule 3 + 9: owned gabe@ attach only to their own campaign after warmup", () => {
    assert.equal(
      callerFollowUpOwnedTargetCampaignId("gabe@gosalesglider.info"),
      GABE_CALLS_SALESGLIDER_ID,
    );
    assert.equal(
      callerFollowUpOwnedTargetCampaignId("gabe@getmesaco.info"),
      GABE_CALLS_EMCOR_ID,
    );
    assert.equal(
      callerFollowUpOwnedTargetCampaignId("gabe@brightlanehq.info"),
      GABE_CALLS_DEEP_ROOTS_ID,
    );
    assert.equal(isCallerFollowUpOwnedSeat("gabe@steadfieldhq.info"), true);
    assert.equal(isCallerFollowUpOwnedSeat("gabriel@sorrelquotaio.co"), false);
    assert.equal(
      callerFollowUpMayAttach({
        email: "gabe@brightlanehq.info",
        account: { from_email: "gabe@brightlanehq.info" },
        campaign: gabeCallsDeepRoots,
        warmed: false,
      }).ok,
      false,
    );
    assert.equal(
      callerFollowUpMayAttach({
        email: "gabe@brightlanehq.info",
        account: { from_email: "gabe@brightlanehq.info" },
        campaign: gabeCallsDeepRoots,
        warmed: true,
      }).ok,
      true,
    );
    assert.equal(
      callerFollowUpMayAttach({
        email: "gabe@brightlanehq.info",
        account: { from_email: "gabe@brightlanehq.info" },
        campaign: { id: GABE_CALLS_SALESGLIDER_ID, name: "Gabe Calls | SalesGlider" },
        warmed: true,
      }).ok,
      false,
    );
    assert.equal(
      callerFollowUpMayAttach({
        email: "gabe@brightlanehq.info",
        account: { from_email: "gabe@brightlanehq.info" },
        campaign: regular,
        warmed: true,
      }).ok,
      false,
    );
    const owned = Object.values(CALLER_FOLLOWUP_OWNED_DOMAINS_BY_CAMPAIGN).flat();
    assert.equal(owned.length, 12);
    assert.ok(owned.includes("gosalesglider.info"));
    assert.ok(owned.includes("trymesaco.info"));
    assert.ok(owned.includes("northpeakteam.info"));
  });

  it("D244: GABE-VM-RESERVED tag does not skip owned-seat warmup or own-campaign (10/7)", () => {
    const salesglider = {
      id: GABE_CALLS_SALESGLIDER_ID,
      name: "Gabe Calls | SalesGlider",
    };
    const reservedMesa = {
      from_email: "gabe@getmesaco.info",
      tags: [{ tag_name: "GABE-VM-RESERVED" }, { tag_name: "POD-A" }],
    };
    const reservedDeepRoots = {
      from_email: "gabe@brightlanehq.info",
      tags: [{ tag_name: "GABE-VM-RESERVED" }, { tag_name: "type:m365" }],
    };
    const reservedSalesGlider = {
      from_email: "gabe@gosalesglider.info",
      tags: [{ tag_name: "GABE-VM-RESERVED" }],
    };
    const unlistedReserved = {
      from_email: "gabe@larkhavenco.info",
      tags: [{ tag_name: "GABE-VM-RESERVED" }],
    };
    assert.equal(
      callerFollowUpMayAttach({
        account: reservedMesa,
        campaign: salesglider,
        warmed: false,
      }).ok,
      false,
      "Mesa reserved gabe@ must not attach to #4085158",
    );
    assert.equal(
      callerFollowUpMayAttach({
        account: reservedDeepRoots,
        campaign: salesglider,
        warmed: false,
      }).ok,
      false,
      "Deep Roots reserved gabe@ must not attach to #4085158",
    );
    assert.equal(
      callerFollowUpMayAttach({
        account: reservedSalesGlider,
        campaign: salesglider,
        warmed: false,
      }).ok,
      false,
      "unwarmed SalesGlider gabe@ must not attach even when tagged reserved",
    );
    assert.equal(
      callerFollowUpMayAttach({
        account: unlistedReserved,
        campaign: salesglider,
        warmed: true,
      }).ok,
      false,
      "unlisted reserved gabe@ never attaches",
    );
    assert.equal(
      callerFollowUpMayAttach({
        account: reservedMesa,
        campaign: salesglider,
        warmed: true,
      }).ok,
      false,
      "warmed Mesa gabe@ still only attaches to its own Gabe Calls campaign",
    );
    assert.equal(
      callerFollowUpMayAttach({
        account: reservedSalesGlider,
        campaign: salesglider,
        warmed: true,
      }).ok,
      true,
      "warmed owned SalesGlider gabe@ may attach to its own campaign",
    );
    assert.equal(callerFollowUpMustSkipPodTags(reservedMesa), true);
    assert.equal(callerFollowUpMustSkipPodTags(unlistedReserved), true);
    assert.equal(
      callerFollowUpMustSkipPodTags({ from_email: "gabe@gosalesglider.info" }),
      true,
    );
  });

  it("rule 4: exempt from A/B rest and the generic send clock", () => {
    assert.equal(callerFollowUpSkipsRestCycle(tagged), true);
    assert.equal(
      callerFollowUpSkipsRestCycle({ tags: [{ tag_name: "POD-A" }] }),
      false,
    );
  });

  it("rule 5: exempt from half-client staffing floor and ESP mix", () => {
    assert.equal(callerFollowUpSkipsStaffingFloor(gabeCallsDeepRoots), true);
    assert.equal(callerFollowUpSkipsEspMix(gabeCallsDeepRoots), true);
    assert.equal(callerFollowUpSkipsStaffingFloor(regular), false);
    assert.equal(callerFollowUpSkipsEspMix(regular), false);
  });

  it("rule 6: Mon-Fri 07:00-20:00 America/Chicago, min_time_btw_emails 3", () => {
    assert.equal(CALLER_FOLLOWUP_TIMEZONE, "America/Chicago");
    assert.equal(CALLER_FOLLOWUP_START_HOUR, 7);
    assert.equal(CALLER_FOLLOWUP_END_HOUR, 20);
    assert.deepEqual([...CALLER_FOLLOWUP_DAYS_OF_WEEK], [1, 2, 3, 4, 5]);
    assert.equal(CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS, 3);
    assert.equal(callerFollowUpSkipsCanonMinGap(gabeCallsDeepRoots), true);
    assert.equal(isCallerFollowUpCanonGapValue(3), true);
    assert.equal(isCallerFollowUpCanonGapValue(10), false);
    assert.equal(
      callerFollowUpScheduleHolds({
        timezone: "America/Chicago",
        daysOfTheWeek: [1, 2, 3, 4, 5],
        startHour: 7,
        endHour: 20,
        minTimeBtwEmails: 3,
      }),
      true,
    );
    assert.equal(
      callerFollowUpScheduleHolds({
        timezone: "America/New_York",
        daysOfTheWeek: [1, 2, 3, 4],
        startHour: 8,
        endHour: 19,
        minTimeBtwEmails: 10,
      }),
      false,
    );
  });

  it("rule 7: exempt from runway and top-up alerts", () => {
    assert.equal(callerFollowUpSkipsRunwayAndTopUpAlerts(gabeCallsDeepRoots), true);
    assert.equal(callerFollowUpSkipsRunwayAndTopUpAlerts(regular), false);
  });

  it("rule 8: kill or unlink pages Josh and does not act", () => {
    assert.equal(
      callerFollowUpMustPageBeforeAct({ action: "unlink", account: tagged }),
      true,
    );
    assert.equal(
      callerFollowUpMustPageBeforeAct({ action: "kill", account: tagged }),
      true,
    );
    assert.equal(
      callerFollowUpMustPageBeforeAct({
        action: "unlink",
        account: { tags: [{ tag_name: "POD-A" }] },
      }),
      false,
    );
    const text = callerFollowUpHumanActionAlert({
      action: "unlink",
      email: "gabriel@sorrelquotaio.co",
      campaignId: 4085160,
      campaignName: "Gabe Calls | Deep Roots",
      reason: "blacklist hit",
    });
    assert.match(text, /CALLER FOLLOW-UP needs Josh/);
    assert.match(text, /will not unlink/);
    assert.match(text, /gabriel@sorrelquotaio\.co/);
    assert.equal(
      callerFollowUpAlertKey({
        action: "unlink",
        email: "gabriel@sorrelquotaio.co",
        campaignId: 4085160,
      }),
      "caller-followup:unlink:gabriel@sorrelquotaio.co:4085160",
    );
  });

  it("rule 9: bridge seats are due off by Nov 3; owned seats are listed", () => {
    assert.equal(CALLER_FOLLOWUP_BRIDGE_REMOVE_BY, "2026-11-03");
    assert.equal(
      callerFollowUpBridgeShouldBeRemoved(new Date("2026-11-02T12:00:00Z")),
      false,
    );
    assert.equal(
      callerFollowUpBridgeShouldBeRemoved(new Date("2026-11-03T00:00:00Z")),
      true,
    );
    const text = callerFollowUpBridgeRemovalAlert();
    assert.match(text, /2026-11-03/);
    assert.match(text, /will not unlink/);
    assert.match(text, /gabriel@sorrelquotaio\.co/);
  });

  it("rule 10: never START or PAUSE these campaigns", () => {
    assert.equal(callerFollowUpForbidsStatusWrite(gabeCallsDeepRoots), true);
    assert.equal(callerFollowUpForbidsStatusWrite(regular), false);
    assert.equal(
      callerFollowUpMustPageBeforeAct({
        action: "start",
        campaign: gabeCallsDeepRoots,
      }),
      true,
    );
    assert.equal(
      callerFollowUpMustPageBeforeAct({
        action: "pause",
        campaign: gabeCallsDeepRoots,
      }),
      true,
    );
  });

  it("leaves message_per_day alone — caps ramp manually (35 on Oct 12)", () => {
    assert.equal(callerFollowUpMustKeepMessagePerDay(tagged), true);
    assert.equal(CALLER_FOLLOWUP_CAP_RAMP_YMD, "2026-10-12");
    assert.equal(CALLER_FOLLOWUP_CAP_RAMP_TO, 35);
  });

  it("lists campaigns already linked to a class sender (cross-client exception)", () => {
    assert.deepEqual(
      callerFollowUpCampaignIdsFromSenders([
        {
          tags: [{ tag_name: "GABE-VM-RESERVED" }],
          campaign_ids: [4085158, 4085159, 4085160],
        },
      ]),
      [4085158, 4085159, 4085160],
    );
  });
});
