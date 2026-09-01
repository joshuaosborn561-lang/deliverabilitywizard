/**
 * D71 — Slack is only deliverability flags plus one end-of-day scoreboard.
 * Everything else stays in logs /ops. D149 adds `ops_alert`: the machine
 * reporting itself broken (overdue watchdog stage, wrong deploy identity,
 * Smartlead mailbox-list API out with no accepted book) pages Slack
 * instead of waiting for someone to come read the logs.
 */
export const SLACK_ALLOW_KINDS = [
  "burned_domain",
  "copy_word",
  "eod_summary",
  "action_result",
  "generic_backfill",
  "ops_alert",
] as const;

export type SlackAllowKind = (typeof SLACK_ALLOW_KINDS)[number];

export function slackAllowed(kind?: SlackAllowKind | null): boolean {
  return (
    kind === "burned_domain" ||
    kind === "copy_word" ||
    kind === "eod_summary" ||
    kind === "action_result" ||
    kind === "generic_backfill" ||
    kind === "ops_alert"
  );
}

export function slackKindForIsolationAction(
  kind:
    | "retire_domain"
    | "buy_domains"
    | "buy_isolation_domain"
    | "buy_canary_fleet"
    | "swap_copy"
    | "generic_backfill"
    | "add_signature_tag",
): SlackAllowKind | null {
  if (kind === "swap_copy") return "copy_word";
  // D97 — leftover Add %signature% asks are not Slack. The checker writes.
  if (
    kind === "retire_domain" ||
    kind === "buy_domains" ||
    kind === "buy_isolation_domain"
  ) {
    return "burned_domain";
  }
  if (kind === "generic_backfill") return "generic_backfill";
  return null;
}
