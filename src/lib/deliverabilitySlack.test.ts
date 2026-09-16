import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import {
  slackSignatureValid,
  slackSignatureValidAny,
  slackUrlVerificationChallenge,
} from "./slackSignature.js";
import {
  DLV_APPLY_COPY,
  DLV_DENY_COPY,
  DLV_GENERICS_NOT_NOW,
  DLV_KEEP_PAUSED,
  DLV_LEAVE_ACTIVE,
  DLV_RETIRE_APPROVE,
  DLV_RETIRE_DENY,
  DELIVERABILITY_SLACK_CHANNEL_ID,
  INSIGHT_SEG_CAMPAIGN_ID,
  WATCHDOG_SLACK_CHANNEL_NAME,
  buildDeliverabilityDecisionCard,
  canTapDlvAction,
  deliverabilityChannelId,
  deliverabilitySigningSecrets,
  encodeDlvButtonValue,
  handleDeliverabilitySlackAction,
  isDlvActionId,
  lockedStandingPrefReason,
  parseDlvButtonValue,
} from "./deliverabilitySlack.js";

function freshState(): StateStore {
  return new StateStore(
    `/tmp/dw-dlv-slack-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

function pendingAction(
  kind: IsolationActionRecord["kind"],
  id: string,
): IsolationActionRecord {
  return {
    id,
    kind,
    status: "pending",
    title: kind,
    proof: "test",
    detail: { campaignId: 3739758, campaignName: "SG Engagers" },
    allowed: "owner_or_operator",
    requestedAt: "2026-09-16T00:00:00.000Z",
  };
}

describe("D194 deliverability Slack one-taps", () => {
  it("accepts the dedicated signing secret (legacy secret also works)", () => {
    const dedicated = "dlv-secret";
    const legacy = "legacy-secret";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "payload=%7B%7D";
    const signature = `v0=${createHmac("sha256", dedicated)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;
    assert.equal(
      slackSignatureValid({
        signingSecret: dedicated,
        timestamp,
        rawBody,
        signature,
      }),
      true,
    );
    assert.equal(
      slackSignatureValidAny({
        signingSecrets: deliverabilitySigningSecrets({
          deliverabilitySlackSigningSecret: dedicated,
          slackSigningSecret: legacy,
        }),
        timestamp,
        rawBody,
        signature,
      }),
      true,
    );
    assert.equal(
      slackSignatureValidAny({
        signingSecrets: [legacy],
        timestamp,
        rawBody,
        signature,
      }),
      false,
    );
  });

  it("url_verification returns the challenge", () => {
    assert.equal(
      slackUrlVerificationChallenge({
        type: "url_verification",
        challenge: "abc123",
      }),
      "abc123",
    );
    assert.equal(slackUrlVerificationChallenge({ type: "event_callback" }), undefined);
  });

  it("default channel is #deliverability C0BJQUTV7A8 — never Watchdog", () => {
    assert.equal(deliverabilityChannelId({}), DELIVERABILITY_SLACK_CHANNEL_ID);
    assert.equal(DELIVERABILITY_SLACK_CHANNEL_ID, "C0BJQUTV7A8");
    assert.notEqual(DELIVERABILITY_SLACK_CHANNEL_ID, WATCHDOG_SLACK_CHANNEL_NAME);
    assert.equal(
      deliverabilityChannelId({ deliverabilitySlackChannelId: "C0BJQUTV7A8" }),
      "C0BJQUTV7A8",
    );
  });

  it("decision card carries campaign id and the first-set action_ids", () => {
    const card = buildDeliverabilityDecisionCard({
      kind: "apply_copy",
      campaignId: 3739758,
      campaignName: "SG Engagers",
      reason: "Merge-tag fill miss — Apply is human-only.",
      isolationActionId: "swap_copy-1",
    });
    assert.match(card.text, /SG Engagers/);
    assert.match(card.text, /#3739758/);
    assert.equal(card.metadata.event_payload.campaign_id, 3739758);
    const actions = (card.blocks[1] as { elements: Array<{ action_id: string }> })
      .elements;
    assert.deepEqual(
      actions.map((el) => el.action_id),
      [DLV_APPLY_COPY, DLV_DENY_COPY],
    );

    const retire = buildDeliverabilityDecisionCard({
      kind: "retire",
      campaignId: 1,
      campaignName: "BCP HC",
      reason: "AS(42004) on burned.info",
      isolationActionId: "retire_domain-1",
    });
    const retireIds = (
      retire.blocks[1] as { elements: Array<{ action_id: string }> }
    ).elements.map((el) => el.action_id);
    assert.deepEqual(retireIds, [DLV_RETIRE_APPROVE, DLV_RETIRE_DENY]);

    const standing = buildDeliverabilityDecisionCard({
      kind: "standing",
      campaignId: 99,
      campaignName: "Parlay SEG",
      reason: "Standing START/PAUSE pref.",
    });
    const standingIds = (
      standing.blocks[1] as { elements: Array<{ action_id: string }> }
    ).elements.map((el) => el.action_id);
    assert.deepEqual(standingIds, [DLV_LEAVE_ACTIVE, DLV_KEEP_PAUSED]);

    const generics = buildDeliverabilityDecisionCard({
      kind: "generics",
      campaignId: 2,
      campaignName: "TechEvo",
      reason: "Allow-generics gate.",
    });
    const genIds = (
      generics.blocks[1] as { elements: Array<{ action_id: string }> }
    ).elements.map((el) => el.action_id);
    assert.deepEqual(genIds, [DLV_GENERICS_NOT_NOW]);
  });

  it("button value round-trips campaign metadata", () => {
    const value = encodeDlvButtonValue({
      campaignId: 3739758,
      campaignName: "SG Engagers",
      isolationActionId: "swap_copy-1",
    });
    assert.deepEqual(parseDlvButtonValue(value), {
      campaignId: 3739758,
      campaignName: "SG Engagers",
      clientId: undefined,
      isolationActionId: "swap_copy-1",
      reason: undefined,
    });
    assert.deepEqual(
      parseDlvButtonValue(undefined, {
        campaign_id: 99,
        campaign_name: "From metadata",
      }),
      {
        campaignId: 99,
        campaignName: "From metadata",
        clientId: undefined,
        isolationActionId: undefined,
        reason: undefined,
      },
    );
  });

  it("Josh-only gates refuse Cayden; retire accepts Cayden", () => {
    assert.equal(canTapDlvAction(DLV_APPLY_COPY, "owner"), true);
    assert.equal(canTapDlvAction(DLV_APPLY_COPY, "operator"), false);
    assert.equal(canTapDlvAction(DLV_GENERICS_NOT_NOW, "operator"), false);
    assert.equal(canTapDlvAction(DLV_RETIRE_APPROVE, "operator"), true);
    assert.equal(canTapDlvAction(DLV_LEAVE_ACTIVE, "operator"), true);
    assert.equal(isDlvActionId("isolation_approve"), false);
    assert.equal(isDlvActionId(DLV_KEEP_PAUSED), true);
  });

  it("dlv_apply_copy calls the existing swap_copy Apply path", async () => {
    const state = freshState();
    await state.load();
    state.upsertIsolationAction(pendingAction("swap_copy", "swap_copy-1"));
    const calls: Array<[string, string]> = [];
    const result = await handleDeliverabilitySlackAction({
      actionId: DLV_APPLY_COPY,
      value: encodeDlvButtonValue({
        campaignId: 3739758,
        campaignName: "SG Engagers",
        isolationActionId: "swap_copy-1",
      }),
      actor: { name: "Josh", role: "owner" },
      state,
      isolationExecute: {
        decide: async (id, decision) => {
          calls.push([id, decision]);
          return { ok: true, message: "Done." };
        },
      },
    });
    assert.deepEqual(calls, [["swap_copy-1", "approve"]]);
    assert.equal(result.ok, true);
    assert.equal(state.listDeliverabilityDecisions()[0]?.decision, "apply_copy");
  });

  it("dlv_deny_copy leaves live copy (deny existing ask or record)", async () => {
    const state = freshState();
    await state.load();
    state.upsertIsolationAction(pendingAction("swap_copy", "swap_copy-1"));
    const result = await handleDeliverabilitySlackAction({
      actionId: DLV_DENY_COPY,
      value: encodeDlvButtonValue({
        campaignId: 3739758,
        isolationActionId: "swap_copy-1",
      }),
      actor: { name: "Josh", role: "owner" },
      state,
      isolationExecute: {
        decide: async (_id, decision) => {
          assert.equal(decision, "deny");
          return { ok: true, message: "Okay — I left it alone." };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.match(result.message, /left it alone/);
  });

  it("Cayden cannot Apply copy", async () => {
    const state = freshState();
    await state.load();
    const result = await handleDeliverabilitySlackAction({
      actionId: DLV_APPLY_COPY,
      value: encodeDlvButtonValue({ campaignId: 1 }),
      actor: { name: "Cayden", role: "operator" },
      state,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /Only Josh/);
  });

  it("dlv_retire_approve reuses the existing retire decide path when an ask is pending", async () => {
    const state = freshState();
    await state.load();
    state.upsertIsolationAction(pendingAction("retire_domain", "retire_domain-1"));
    const calls: Array<[string, string]> = [];
    const result = await handleDeliverabilitySlackAction({
      actionId: DLV_RETIRE_APPROVE,
      value: encodeDlvButtonValue({
        campaignId: 1,
        isolationActionId: "retire_domain-1",
      }),
      actor: { name: "Cayden", role: "operator" },
      state,
      isolationExecute: {
        decide: async (id, decision) => {
          calls.push([id, decision]);
          return { ok: true, message: "Done." };
        },
      },
    });
    assert.deepEqual(calls, [["retire_domain-1", "approve"]]);
    assert.equal(result.spent, true);
    assert.equal(result.ok, true);
  });

  it("dlv_retire_approve does not spend when no pending retire ask exists", async () => {
    const state = freshState();
    await state.load();
    let decideCalls = 0;
    const result = await handleDeliverabilitySlackAction({
      actionId: DLV_RETIRE_APPROVE,
      value: encodeDlvButtonValue({ campaignId: 1, campaignName: "BCP HC" }),
      actor: { name: "Cayden", role: "operator" },
      state,
      isolationExecute: {
        decide: async () => {
          decideCalls += 1;
          return { ok: true, message: "should not run" };
        },
      },
    });
    assert.equal(decideCalls, 0);
    assert.equal(result.spent, false);
    assert.match(result.message, /did not spend/);
    assert.equal(
      state.listDeliverabilityDecisions()[0]?.decision,
      "retire_approve",
    );
  });

  it("dlv_retire_deny denies a pending retire ask", async () => {
    const state = freshState();
    await state.load();
    state.upsertIsolationAction(pendingAction("buy_domains", "buy_domains-1"));
    const result = await handleDeliverabilitySlackAction({
      actionId: DLV_RETIRE_DENY,
      value: encodeDlvButtonValue({
        campaignId: 1,
        isolationActionId: "buy_domains-1",
      }),
      actor: { name: "Cayden", role: "operator" },
      state,
      isolationExecute: {
        decide: async (_id, decision) => {
          assert.equal(decision, "deny");
          return { ok: true, message: "Okay — I left it alone." };
        },
      },
    });
    assert.equal(result.ok, true);
  });

  it("dlv_leave_active / dlv_keep_paused write standing prefs and never START/PAUSE", async () => {
    const state = freshState();
    await state.load();
    const active = await handleDeliverabilitySlackAction({
      actionId: DLV_LEAVE_ACTIVE,
      value: encodeDlvButtonValue({
        campaignId: 3739758,
        campaignName: "SG Engagers",
      }),
      actor: { name: "Josh", role: "owner" },
      state,
    });
    assert.equal(active.ok, true);
    assert.match(active.message, /did not START or PAUSE/);
    assert.equal(state.getCampaignStandingPref(3739758)?.pref, "leave_active");

    const paused = await handleDeliverabilitySlackAction({
      actionId: DLV_KEEP_PAUSED,
      value: encodeDlvButtonValue({
        campaignId: 3739758,
        campaignName: "SG Engagers",
      }),
      actor: { name: "Cayden", role: "operator" },
      state,
    });
    assert.equal(paused.ok, true);
    assert.equal(state.getCampaignStandingPref(3739758)?.pref, "keep_paused");
  });

  it("refuses to change Goliath hold or Insight SEG standing prefs", async () => {
    assert.match(
      lockedStandingPrefReason({ clientId: 548611, campaignId: 1 }) ?? "",
      /Goliath/,
    );
    assert.match(
      lockedStandingPrefReason({ campaignId: INSIGHT_SEG_CAMPAIGN_ID }) ?? "",
      /Insight SEG/,
    );
    const state = freshState();
    await state.load();
    const goliath = await handleDeliverabilitySlackAction({
      actionId: DLV_LEAVE_ACTIVE,
      value: encodeDlvButtonValue({
        campaignId: 3851730,
        campaignName: "Goliath MDR",
        clientId: 548611,
      }),
      actor: { name: "Josh", role: "owner" },
      state,
    });
    assert.equal(goliath.ok, false);
    assert.match(goliath.message, /Goliath/);
    assert.equal(state.getCampaignStandingPref(3851730), undefined);

    const seg = await handleDeliverabilitySlackAction({
      actionId: DLV_KEEP_PAUSED,
      value: encodeDlvButtonValue({
        campaignId: INSIGHT_SEG_CAMPAIGN_ID,
        campaignName: "Insight Consolidation Gateway SEG",
      }),
      actor: { name: "Josh", role: "owner" },
      state,
    });
    assert.equal(seg.ok, false);
    assert.match(seg.message, /Insight SEG/);
    assert.equal(state.getCampaignStandingPref(INSIGHT_SEG_CAMPAIGN_ID), undefined);
  });

  it("dlv_generics_not_now is Josh-only and never Allows", async () => {
    const state = freshState();
    await state.load();
    state.upsertIsolationAction(
      pendingAction("generic_backfill", "generic_backfill-1"),
    );
    const cayden = await handleDeliverabilitySlackAction({
      actionId: DLV_GENERICS_NOT_NOW,
      value: encodeDlvButtonValue({
        campaignId: 2,
        isolationActionId: "generic_backfill-1",
      }),
      actor: { name: "Cayden", role: "operator" },
      state,
    });
    assert.equal(cayden.ok, false);

    const decisions: string[] = [];
    const josh = await handleDeliverabilitySlackAction({
      actionId: DLV_GENERICS_NOT_NOW,
      value: encodeDlvButtonValue({
        campaignId: 2,
        isolationActionId: "generic_backfill-1",
      }),
      actor: { name: "Josh", role: "owner" },
      state,
      isolationExecute: {
        decide: async (_id, decision) => {
          decisions.push(decision);
          return { ok: true, message: "Okay — I left it alone." };
        },
      },
    });
    assert.deepEqual(decisions, ["deny"]);
    assert.equal(josh.ok, true);
    assert.doesNotMatch(josh.message, /Allow/);
  });
});
