/**
 * D248 — isolation ask buttons are native Slack buttons. Spend / destructive
 * Approve (Retire / Buy) carries Slack's `confirm` dialog so a single tap
 * cannot spend. Link buttons (`url`) never decide — leftover confirm-page
 * buttons that still have action_id + url are ignored by the handler.
 */

export const ISOLATION_APPROVE_ACTION = "isolation_approve";
export const ISOLATION_DENY_ACTION = "isolation_deny";
export const NEEDS_YOU_APPROVE_ACTION = "needs_you_approve_client";

export type IsolationAskKind =
  | "retire_domain"
  | "buy_domains"
  | "buy_isolation_domain"
  | "buy_canary_fleet"
  | "swap_copy"
  | "generic_backfill"
  | "add_signature_tag";

export function isolationAskNeedsConfirm(
  kind: IsolationAskKind | string,
  decision: "approve" | "deny" | "edit",
): boolean {
  if (decision !== "approve") return false;
  return (
    kind === "retire_domain" ||
    kind === "buy_domains" ||
    kind === "buy_isolation_domain" ||
    kind === "buy_canary_fleet"
  );
}

export function slackConfirmDialog(input: {
  kind: string;
  decision: "approve" | "deny" | "edit";
  label: string;
}): Record<string, unknown> | undefined {
  if (!isolationAskNeedsConfirm(input.kind, input.decision)) return undefined;
  const spend =
    input.kind === "retire_domain"
      ? "This pulls every inbox on the domain and buys a client-named replacement. Confirming spends real money."
      : "This buys domains or inboxes. Confirming spends real money.";
  return {
    title: { type: "plain_text", text: "Confirm" },
    text: { type: "mrkdwn", text: spend },
    confirm: { type: "plain_text", text: input.label.slice(0, 30) || "Confirm" },
    deny: { type: "plain_text", text: "Cancel" },
  };
}

export function needsYouConfirmDialog(clientName: string): Record<string, unknown> {
  return {
    title: { type: "plain_text", text: "Approve spend" },
    text: {
      type: "mrkdwn",
      text: `Approve every pending Retire / Buy for *${clientName}*. Confirming can spend real money.`,
    },
    confirm: { type: "plain_text", text: "Approve" },
    deny: { type: "plain_text", text: "Cancel" },
  };
}

export interface SlackButtonElement {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  value: string;
  style?: "primary" | "danger";
  confirm?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Native button. Never a `url`. Confirm is required for spend Approve. */
export function isolationNativeButton(input: {
  label: string;
  actionId: string;
  value: string;
  kind: string;
  decision: "approve" | "deny" | "edit";
  style?: "primary" | "danger";
}): SlackButtonElement {
  const button: SlackButtonElement = {
    type: "button",
    text: { type: "plain_text", text: input.label },
    action_id: input.actionId,
    value: input.value,
  };
  if (input.style) button.style = input.style;
  const confirm = slackConfirmDialog({
    kind: input.kind,
    decision: input.decision,
    label: input.label,
  });
  if (confirm) button.confirm = confirm;
  return button;
}

export function buttonHasUrl(action: {
  url?: unknown;
}): boolean {
  return typeof action.url === "string" && action.url.trim().length > 0;
}

/**
 * A leftover confirm-page link button still posts block_actions. Do not
 * treat that click as a decision — Slack already opened the URL.
 */
export function isolationBlockActionShouldDecide(action: {
  action_id?: string;
  url?: unknown;
  value?: string;
}): { decide: boolean; reason: string } {
  if (buttonHasUrl(action)) {
    return { decide: false, reason: "url_button" };
  }
  const actionId = action.action_id ?? "";
  const needsYou =
    actionId === NEEDS_YOU_APPROVE_ACTION ||
    actionId.startsWith(`${NEEDS_YOU_APPROVE_ACTION}:`);
  if (
    actionId !== ISOLATION_APPROVE_ACTION &&
    actionId !== ISOLATION_DENY_ACTION &&
    !needsYou
  ) {
    return { decide: false, reason: "not_isolation" };
  }
  if (!action.value?.trim()) {
    return { decide: false, reason: "missing_value" };
  }
  return { decide: true, reason: "native" };
}
