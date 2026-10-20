/**
 * D294 — boot-time sanity for Slack owner / operator IDs.
 *
 * Production 2026-10-20 had SLACK_JOSH_USER_ID and SLACK_CAYDEN_USER_ID
 * swapped, so Cayden was treated as owner "Josh". Env was fixed by hand;
 * this logs the configured ids at boot and warns on overlap or a known
 * swap. It does not rewrite env.
 */

export const KNOWN_SLACK_JOSH_USER_ID = "U0AAX2XFJE7";
export const KNOWN_SLACK_CAYDEN_USER_ID = "U0BL8JT75KN";

export function slackActorIdSanity(
  joshIds: string[],
  caydenIds: string[],
): { ok: boolean; warnings: string[]; line: string } {
  const josh = [...new Set(joshIds.map((id) => id.trim()).filter(Boolean))];
  const cayden = [...new Set(caydenIds.map((id) => id.trim()).filter(Boolean))];
  const joshSet = new Set(josh);
  const caydenSet = new Set(cayden);
  const warnings: string[] = [];
  if (!josh.length) warnings.push("SLACK_JOSH_USER_ID is empty");
  if (!cayden.length) warnings.push("SLACK_CAYDEN_USER_ID is empty");
  for (const id of josh) {
    if (caydenSet.has(id)) {
      warnings.push(`Slack user ${id} is in both Josh and Cayden lists`);
    }
  }
  if (joshSet.has(KNOWN_SLACK_CAYDEN_USER_ID)) {
    warnings.push(
      `SLACK_JOSH_USER_ID contains Cayden's id ${KNOWN_SLACK_CAYDEN_USER_ID} — IDs look swapped`,
    );
  }
  if (caydenSet.has(KNOWN_SLACK_JOSH_USER_ID)) {
    warnings.push(
      `SLACK_CAYDEN_USER_ID contains Josh's id ${KNOWN_SLACK_JOSH_USER_ID} — IDs look swapped`,
    );
  }
  const line = `[boot] Slack actors (D294): Josh=${josh.join(",") || "(unset)"} Cayden=${cayden.join(",") || "(unset)"}${
    warnings.length ? ` WARN ${warnings.join("; ")}` : ""
  }`;
  return { ok: warnings.length === 0, warnings, line };
}
