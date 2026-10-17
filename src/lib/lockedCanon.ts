/**
 * D285 — LOCKED core canon. Josh-only. Never auto-merge a PR that
 * changes this text. The same string is mirrored in CANON.md and
 * docs/LOCKED-CANON.md; the guard fails if any copy drifts.
 */

export const LOCKED_CANON_HEADING = "LOCKED — Josh-only changes";

export const LOCKED_CANON_APPROVAL_NOTE =
  "Changes to this section require Josh's explicit approval. PRs that alter it must never auto-merge.";

export const LOCKED_POD_40_RULE =
  "POD-40: every client POD A and POD B must each hold >=40 warm seats the client owns (TechEvo 30), counted per POD, never per campaign; borrowed seats never count; when under, rotate free warm generics in (Insight: no generics, alert Josh daily). Never narrow, skip the off-week POD, or exempt any client from the count.";

export function extractLockedCanonSection(markdown: string): string {
  const heading = `## ${LOCKED_CANON_HEADING}`;
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const rest = markdown.slice(start);
  const next = rest.search(/\n## (?!LOCKED)/);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

export function lockedCanonSectionBody(): string {
  return [
    `## ${LOCKED_CANON_HEADING}`,
    "",
    LOCKED_CANON_APPROVAL_NOTE,
    "",
    `- ${LOCKED_POD_40_RULE}`,
  ].join("\n");
}
