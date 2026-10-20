export type IsolationActorRole = "owner" | "operator" | "unknown";

export function slackRoleOf(
  slackUserId: string | undefined,
  joshIds: string[],
  caydenIds: string[],
): IsolationActorRole {
  const id = slackUserId?.trim();
  if (!id) return "unknown";
  if (joshIds.includes(id)) return "owner";
  if (caydenIds.includes(id)) return "operator";
  return "unknown";
}

export function canDecideIsolationAction(
  kind:
    | "retire_domain"
    | "buy_domains"
    | "buy_isolation_domain"
    | "buy_canary_fleet"
    | "swap_copy"
    | "generic_backfill"
    | "add_signature_tag",
  role: IsolationActorRole | "owner" | "operator",
  opts?: { insight?: boolean },
): boolean {
  // Copy edits plus burned-domain Retire / replacement Buy (D190).
  // Canary fleet, isolation-domain buy, and Insight spend stay Josh-only (D296).
  if (opts?.insight && (kind === "retire_domain" || kind === "buy_domains")) {
    return role === "owner";
  }
  if (
    kind === "swap_copy" ||
    kind === "add_signature_tag" ||
    kind === "retire_domain" ||
    kind === "buy_domains"
  ) {
    return role === "owner" || role === "operator";
  }
  return role === "owner";
}
