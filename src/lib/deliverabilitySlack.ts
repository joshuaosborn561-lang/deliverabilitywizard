/**
 * D194 — dedicated #deliverability interactive one-taps.
 *
 * Extends the existing `/slack/interactions` stack (signature verify +
 * isolation execute). Does not post to #campaign-watchdog — that channel
 * stays on the separate Cursor / Lead Top Up Slack identity.
 */

import type { IsolationActorRole } from "./isolationActors.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import { isPowerGrydLeaveAlone } from "./powerGryd.js";
import type { StateStore } from "../state/store.js";

export const DELIVERABILITY_SLACK_CHANNEL_ID = "C0BJQUTV7A8";
export const DELIVERABILITY_SLACK_CHANNEL_NAME = "#deliverability";

/** Slack channel the Watchdog identity owns — this bot must never post there. */
export const WATCHDOG_SLACK_CHANNEL_NAME = "#campaign-watchdog";

export const DLV_APPLY_COPY = "dlv_apply_copy";
export const DLV_DENY_COPY = "dlv_deny_copy";
export const DLV_RETIRE_APPROVE = "dlv_retire_approve";
export const DLV_RETIRE_DENY = "dlv_retire_deny";
export const DLV_LEAVE_ACTIVE = "dlv_leave_active";
export const DLV_KEEP_PAUSED = "dlv_keep_paused";
export const DLV_GENERICS_NOT_NOW = "dlv_generics_not_now";

export const DLV_ACTION_IDS = [
  DLV_APPLY_COPY,
  DLV_DENY_COPY,
  DLV_RETIRE_APPROVE,
  DLV_RETIRE_DENY,
  DLV_LEAVE_ACTIVE,
  DLV_KEEP_PAUSED,
  DLV_GENERICS_NOT_NOW,
] as const;

export type DlvActionId = (typeof DLV_ACTION_IDS)[number];

export type DlvCardKind = "apply_copy" | "retire" | "standing" | "generics";

export type CampaignStandingPrefValue = "leave_active" | "keep_paused";

export interface DlvButtonPayload {
  campaignId: number;
  campaignName?: string;
  clientId?: number;
  isolationActionId?: string;
  reason?: string;
}

export interface DeliverabilityDecisionRecord {
  id: string;
  actionId: DlvActionId;
  campaignId?: number;
  campaignName?: string;
  isolationActionId?: string;
  decision: string;
  decidedAt: string;
  decidedBy: string;
  note?: string;
}

export interface CampaignStandingPref {
  campaignId: number;
  campaignName?: string;
  pref: CampaignStandingPrefValue;
  decidedAt: string;
  decidedBy: string;
}

export interface IsolationDecide {
  decide(
    actionId: string,
    decision: "approve" | "deny",
    actor: { name: string; role: IsolationActorRole },
  ): Promise<{ ok: boolean; message: string }>;
}

const GOLIATH_CLIENT_ID = 548611;
/** Insight Consolidation Gateway SEG — standing PAUSE, do not flip. */
export const INSIGHT_SEG_CAMPAIGN_ID = 3921647;

export function isDlvActionId(value: string | undefined): value is DlvActionId {
  return Boolean(value && (DLV_ACTION_IDS as readonly string[]).includes(value));
}

export function deliverabilitySigningSecrets(input: {
  deliverabilitySlackSigningSecret?: string;
  slackSigningSecret?: string;
}): string[] {
  return [
    input.deliverabilitySlackSigningSecret ?? "",
    input.slackSigningSecret ?? "",
  ];
}

export function deliverabilityBotToken(input: {
  deliverabilitySlackBotToken?: string;
  slackBotToken?: string;
}): string {
  return (
    input.deliverabilitySlackBotToken?.trim() ||
    input.slackBotToken?.trim() ||
    ""
  );
}

export function deliverabilityChannelId(input?: {
  deliverabilitySlackChannelId?: string;
}): string {
  const raw = input?.deliverabilitySlackChannelId?.trim();
  return raw || DELIVERABILITY_SLACK_CHANNEL_ID;
}

export function encodeDlvButtonValue(payload: DlvButtonPayload): string {
  return JSON.stringify({
    campaignId: payload.campaignId,
    campaignName: payload.campaignName,
    clientId: payload.clientId,
    isolationActionId: payload.isolationActionId,
    reason: payload.reason,
  });
}

export function parseDlvButtonValue(
  value: string | undefined,
  metadata?: Record<string, unknown> | null,
): DlvButtonPayload | undefined {
  const fromValue = parseDlvRecord(safeJson(value));
  const fromMeta = parseDlvRecord(metadata ?? undefined);
  if (!fromValue && !fromMeta) return undefined;
  return {
    campaignId: fromValue?.campaignId ?? fromMeta?.campaignId ?? 0,
    campaignName: fromValue?.campaignName ?? fromMeta?.campaignName,
    clientId: fromValue?.clientId ?? fromMeta?.clientId,
    isolationActionId:
      fromValue?.isolationActionId ?? fromMeta?.isolationActionId,
    reason: fromValue?.reason ?? fromMeta?.reason,
  };
}

function safeJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseDlvRecord(
  rec: Record<string, unknown> | undefined,
): DlvButtonPayload | undefined {
  if (!rec) return undefined;
  const campaignId = Number(rec.campaignId ?? rec.campaign_id);
  const isolationActionId = stringOrUndef(
    rec.isolationActionId ?? rec.isolation_action_id,
  );
  const campaignName = stringOrUndef(rec.campaignName ?? rec.campaign_name);
  const clientIdRaw = rec.clientId ?? rec.client_id;
  const clientId =
    clientIdRaw === undefined || clientIdRaw === ""
      ? undefined
      : Number(clientIdRaw);
  const reason = stringOrUndef(rec.reason);
  if (!Number.isFinite(campaignId) && !isolationActionId) return undefined;
  return {
    campaignId: Number.isFinite(campaignId) ? campaignId : 0,
    campaignName,
    clientId: Number.isFinite(clientId) ? clientId : undefined,
    isolationActionId,
    reason,
  };
}

function stringOrUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Goliath Oct 15 campaign hold and Insight SEG pause are locked standing
 * prefs (D181/D190/D193). One-taps must not rewrite them.
 */
export function lockedStandingPrefReason(input: {
  campaignId?: number;
  campaignName?: string;
  clientId?: number;
}): string | undefined {
  if (input.clientId === GOLIATH_CLIENT_ID) {
    return "Goliath Oct 15 campaign PAUSE hold is unchanged.";
  }
  const name = String(input.campaignName ?? "");
  if (/\bgoliath\b/i.test(name)) {
    return "Goliath Oct 15 campaign PAUSE hold is unchanged.";
  }
  if (
    isPowerGrydLeaveAlone({
      campaignId: input.campaignId,
      clientId: input.clientId,
      campaignName: input.campaignName,
    })
  ) {
    return "PowerGryd POC leave-alone: no START/PAUSE/Retire by automation (D204).";
  }
  if (input.campaignId === INSIGHT_SEG_CAMPAIGN_ID) {
    return "Insight SEG pause standing pref is unchanged.";
  }
  if (/\binsight\b/i.test(name) && /\bseg\b/i.test(name)) {
    return "Insight SEG pause standing pref is unchanged.";
  }
  return undefined;
}

export function slackMetadataForDecision(payload: DlvButtonPayload): {
  event_type: string;
  event_payload: Record<string, string | number>;
} {
  const event_payload: Record<string, string | number> = {
    campaign_id: payload.campaignId,
  };
  if (payload.campaignName) event_payload.campaign_name = payload.campaignName;
  if (payload.isolationActionId) {
    event_payload.isolation_action_id = payload.isolationActionId;
  }
  if (payload.clientId !== undefined) event_payload.client_id = payload.clientId;
  return { event_type: "dlv_decision", event_payload };
}

export function buildDeliverabilityDecisionCard(input: {
  kind: DlvCardKind;
  campaignId: number;
  campaignName: string;
  reason: string;
  isolationActionId?: string;
  clientId?: number;
}): {
  text: string;
  blocks: unknown[];
  metadata: { event_type: string; event_payload: Record<string, string | number> };
} {
  const payload: DlvButtonPayload = {
    campaignId: input.campaignId,
    campaignName: input.campaignName,
    isolationActionId: input.isolationActionId,
    clientId: input.clientId,
    reason: input.reason,
  };
  const value = encodeDlvButtonValue(payload);
  const heading = `*${input.campaignName}* (#${input.campaignId})`;
  const text = `${heading}\n${input.reason}`;
  const buttons = buttonsForKind(input.kind, value);
  return {
    text,
    metadata: slackMetadataForDecision(payload),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
      {
        type: "actions",
        elements: buttons,
      },
    ],
  };
}

function buttonsForKind(
  kind: DlvCardKind,
  value: string,
): Array<Record<string, unknown>> {
  if (kind === "apply_copy") {
    return [
      button("Apply copy", DLV_APPLY_COPY, value, "primary"),
      button("Leave live copy", DLV_DENY_COPY, value),
    ];
  }
  if (kind === "retire") {
    return [
      button("Retire / Buy", DLV_RETIRE_APPROVE, value, "danger"),
      button("Not now", DLV_RETIRE_DENY, value),
    ];
  }
  if (kind === "standing") {
    return [
      button("Leave ACTIVE", DLV_LEAVE_ACTIVE, value, "primary"),
      button("Keep PAUSED", DLV_KEEP_PAUSED, value),
    ];
  }
  return [button("Not now", DLV_GENERICS_NOT_NOW, value)];
}

function button(
  label: string,
  actionId: DlvActionId,
  value: string,
  style?: "primary" | "danger",
): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

export function canTapDlvAction(
  actionId: DlvActionId,
  role: IsolationActorRole,
): boolean {
  if (actionId === DLV_APPLY_COPY || actionId === DLV_DENY_COPY) {
    return role === "owner";
  }
  if (actionId === DLV_GENERICS_NOT_NOW) return role === "owner";
  if (
    actionId === DLV_RETIRE_APPROVE ||
    actionId === DLV_RETIRE_DENY ||
    actionId === DLV_LEAVE_ACTIVE ||
    actionId === DLV_KEEP_PAUSED
  ) {
    return role === "owner" || role === "operator";
  }
  return false;
}

export async function handleDeliverabilitySlackAction(input: {
  actionId: string;
  value?: string;
  messageMetadata?: Record<string, unknown> | null;
  actor: { name: string; role: IsolationActorRole };
  state: Pick<
    StateStore,
    | "getIsolationAction"
    | "upsertIsolationAction"
    | "recordDeliverabilityDecision"
    | "setCampaignStandingPref"
    | "save"
  >;
  isolationExecute?: IsolationDecide;
  now?: Date;
}): Promise<{ ok: boolean; message: string; spent?: boolean }> {
  if (!isDlvActionId(input.actionId)) {
    return { ok: false, message: "That button is not a Deliverability one-tap." };
  }
  if (!canTapDlvAction(input.actionId, input.actor.role)) {
    if (input.actionId === DLV_GENERICS_NOT_NOW) {
      return { ok: false, message: "Only Josh can answer the Allow-generics gate." };
    }
    if (input.actionId === DLV_APPLY_COPY || input.actionId === DLV_DENY_COPY) {
      return { ok: false, message: "Only Josh can Apply or leave live copy." };
    }
    return {
      ok: false,
      message:
        "I do not recognize this Slack user as Josh or Cayden. Approve in Railway → /ops.",
    };
  }

  const parsed = parseDlvButtonValue(input.value, input.messageMetadata);
  const now = (input.now ?? new Date()).toISOString();
  const isolationActionId = parsed?.isolationActionId;
  const pending = isolationActionId
    ? input.state.getIsolationAction(isolationActionId)
    : undefined;

  if (input.actionId === DLV_LEAVE_ACTIVE || input.actionId === DLV_KEEP_PAUSED) {
    const locked = lockedStandingPrefReason({
      campaignId: parsed?.campaignId,
      campaignName: parsed?.campaignName,
      clientId: parsed?.clientId,
    });
    if (locked) {
      return { ok: false, message: locked };
    }
    if (!parsed?.campaignId) {
      return { ok: false, message: "That card is missing campaign_id." };
    }
    const pref: CampaignStandingPrefValue =
      input.actionId === DLV_LEAVE_ACTIVE ? "leave_active" : "keep_paused";
    input.state.setCampaignStandingPref({
      campaignId: parsed.campaignId,
      campaignName: parsed.campaignName,
      pref,
      decidedAt: now,
      decidedBy: input.actor.name,
    });
    recordDecision(input, parsed, now, pref);
    await input.state.save();
    return {
      ok: true,
      message:
        pref === "leave_active"
          ? `Recorded standing pref: leave #${parsed.campaignId} ACTIVE. I did not START or PAUSE anyone.`
          : `Recorded standing pref: keep #${parsed.campaignId} PAUSED. I did not START or PAUSE anyone.`,
    };
  }

  if (input.actionId === DLV_GENERICS_NOT_NOW) {
    const viaExisting = await maybeDecideIsolation({
      pending,
      expectedKinds: ["generic_backfill"],
      decision: "deny",
      actor: input.actor,
      isolationExecute: input.isolationExecute,
    });
    recordDecision(input, parsed, now, "generics_not_now", viaExisting.note);
    await input.state.save();
    return {
      ok: true,
      message:
        viaExisting.message ??
        "Not now — generics stay off. I did not Allow.",
    };
  }

  if (input.actionId === DLV_APPLY_COPY || input.actionId === DLV_DENY_COPY) {
    const decision = input.actionId === DLV_APPLY_COPY ? "approve" : "deny";
    const viaExisting = await maybeDecideIsolation({
      pending,
      expectedKinds: ["swap_copy"],
      decision,
      actor: input.actor,
      isolationExecute: input.isolationExecute,
    });
    recordDecision(
      input,
      parsed,
      now,
      decision === "approve" ? "apply_copy" : "deny_copy",
      viaExisting.note,
    );
    await input.state.save();
    if (viaExisting.message) return { ok: viaExisting.ok, message: viaExisting.message };
    return {
      ok: true,
      message:
        decision === "approve"
          ? "Recorded Apply copy. No pending swap_copy ask to run — live copy is unchanged until one exists."
          : "Leave live copy — recorded. I did not edit the sequence.",
    };
  }

  if (input.actionId === DLV_RETIRE_APPROVE || input.actionId === DLV_RETIRE_DENY) {
    const decision = input.actionId === DLV_RETIRE_APPROVE ? "approve" : "deny";
    if (decision === "approve" && !pending) {
      recordDecision(input, parsed, now, "retire_approve", "queued_no_spend");
      await input.state.save();
      return {
        ok: true,
        spent: false,
        message:
          "Recorded Retire/Buy approval. No pending retire ask — I did not spend.",
      };
    }
    const viaExisting = await maybeDecideIsolation({
      pending,
      expectedKinds: ["retire_domain", "buy_domains"],
      decision,
      actor: input.actor,
      isolationExecute: input.isolationExecute,
    });
    recordDecision(
      input,
      parsed,
      now,
      decision === "approve" ? "retire_approve" : "retire_deny",
      viaExisting.note,
    );
    await input.state.save();
    if (viaExisting.message) {
      return {
        ok: viaExisting.ok,
        spent: decision === "approve" && viaExisting.ok && Boolean(pending),
        message: viaExisting.message,
      };
    }
    return {
      ok: true,
      spent: false,
      message:
        decision === "approve"
          ? "Recorded Retire/Buy approval. No matching pending ask — I did not spend."
          : "Not now — recorded. Nothing was retired or bought.",
    };
  }

  return { ok: false, message: "That button is not one I handle." };
}

function recordDecision(
  input: {
    actionId: string;
    actor: { name: string };
    state: Pick<StateStore, "recordDeliverabilityDecision">;
  },
  parsed: DlvButtonPayload | undefined,
  now: string,
  decision: string,
  note?: string,
): void {
  if (!isDlvActionId(input.actionId)) return;
  input.state.recordDeliverabilityDecision({
    id: `dlv-${input.actionId}-${parsed?.campaignId ?? "x"}-${now}`,
    actionId: input.actionId,
    campaignId: parsed?.campaignId || undefined,
    campaignName: parsed?.campaignName,
    isolationActionId: parsed?.isolationActionId,
    decision,
    decidedAt: now,
    decidedBy: input.actor.name,
    note,
  });
}

async function maybeDecideIsolation(input: {
  pending: IsolationActionRecord | undefined;
  expectedKinds: IsolationActionRecord["kind"][];
  decision: "approve" | "deny";
  actor: { name: string; role: IsolationActorRole };
  isolationExecute?: IsolationDecide;
}): Promise<{ ok: boolean; message?: string; note?: string }> {
  if (!input.pending) return { ok: true };
  if (input.pending.status !== "pending") {
    return {
      ok: true,
      message: `That request is already ${input.pending.status}.`,
      note: `already_${input.pending.status}`,
    };
  }
  if (!input.expectedKinds.includes(input.pending.kind)) {
    return {
      ok: false,
      message: `That card is for ${input.pending.kind}, not this button.`,
      note: "kind_mismatch",
    };
  }
  if (!input.isolationExecute) {
    return { ok: true, note: "no_execute" };
  }
  const result = await input.isolationExecute.decide(
    input.pending.id,
    input.decision,
    input.actor,
  );
  return { ...result, note: "isolation_decide" };
}
