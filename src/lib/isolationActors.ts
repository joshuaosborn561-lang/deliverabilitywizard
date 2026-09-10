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
): boolean {
  // Copy edits (one-word swap, %signature% append) are the operator-safe
  // tier; everything else — spend, teardown, generics — stays owner-only.
  if (kind === "swap_copy" || kind === "add_signature_tag") {
    return role === "owner" || role === "operator";
  }
  return role === "owner";
}

/**
 * D188 — live word Apply is a human Slack /ops tap. Remind, boot,
 * bounce remediation, chat, and a digest agent are not a tap.
 * `system` / empty / wizard / digest names never count even if the
 * role was forged as owner.
 */
export function isHumanCopySwapActor(actor: {
  name?: string;
  role: IsolationActorRole | "owner" | "operator";
}): boolean {
  if (actor.role !== "owner" && actor.role !== "operator") return false;
  const name = String(actor.name ?? "")
    .trim()
    .toLowerCase();
  if (!name) return false;
  if (name === "system" || name === "wizard" || name === "digest") return false;
  return true;
}
