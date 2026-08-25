/**
 * D71 — Slack is only deliverability flags plus one end-of-day scoreboard.
 * Everything else stays in logs /ops.
 */
export const SLACK_ALLOW_KINDS = [
  "burned_domain",
  "copy_word",
  "eod_summary",
  "action_result",
] as const;

export type SlackAllowKind = (typeof SLACK_ALLOW_KINDS)[number];

export function slackAllowed(kind?: SlackAllowKind | null): boolean {
  return (
    kind === "burned_domain" ||
    kind === "copy_word" ||
    kind === "eod_summary" ||
    kind === "action_result"
  );
}

export function slackKindForIsolationAction(
  kind: "retire_domain" | "buy_domains" | "buy_canary_fleet" | "swap_copy",
): SlackAllowKind | null {
  if (kind === "swap_copy") return "copy_word";
  if (kind === "retire_domain" || kind === "buy_domains") return "burned_domain";
  return null;
}
