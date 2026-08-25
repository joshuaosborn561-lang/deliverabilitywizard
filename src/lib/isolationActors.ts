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
    | "buy_canary_fleet"
    | "swap_copy"
    | "generic_backfill",
  role: IsolationActorRole | "owner" | "operator",
): boolean {
  if (kind === "swap_copy") return role === "owner" || role === "operator";
  return role === "owner";
}
