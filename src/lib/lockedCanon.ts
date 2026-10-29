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

export const LOCKED_GENERICS_LEDGER_RULE =
  "Generics Ledger: Every generic inbox we own has exactly one row: email, ESP, warmup on/off, assigned client (blank = free pool), assigned POD (A/B), assigned_at, and covering_for (the specific branded seats of that client it stands in for, each with its 14-day warm-ready date). All generics warm continuously; any generic found not warming gets warmup turned back on the same day. A generic is assigned only to fill one client's POD to 40 (30 TechEvo), to one client and one POD, and never moves PODs. Branded is preferred: when a covered branded seat reaches 14 days warm, it goes into the POD and the generic it covered comes out the same day: unlinked, client_id cleared, POD/POC tags stripped, signature reset, back to the free pool. No generic is assigned or released outside the ledger. Insight never receives generics; every other client, including PowerGRYD, does. CornerStone-domain inboxes are never generics and never in the pool. A generic on a live campaign without a ledger row, a generic tagged to Insight, a generic not warming, or a POD under 40 with no free warm generic alerts Josh the same day.";

export const LOCKED_ESP_MATCH_GAP_RULE =
  "ESP matching + 10m gap: every Smartlead campaign has AI ESP matching ON (enable_ai_esp_matching: true) and min_time_btw_emails = 10, always (D304). The wizard flags and fixes drift on sight with settings / schedule writes only, never a status change; STOPPED campaigns are left alone.";

export const LOCKED_REAL_PERSONA_RULE =
  "Every inbox has a name (D321): no mailbox may be linked to a live campaign, or send, with a blank or placeholder from_name or signature name (Pool User, Generic, Canary, test, one word, the email local part, or any other placeholder word). A seat sends as its persona from the Generics Ledger / InboxKit; with no persona it sends as the client company name (from_name = company, signature = company). The wizard never invents or defaults a name and never refuses an assign for a missing persona. A sweep every 10 minutes replaces any placeholder on a non-STOPPED campaign with the persona, or the company name, writing from_name and signature only (never unlink, never a status change, never copy or leads); signature checks treat a blank or placeholder name as a mismatch; releasing a generic restores its persona. Exempt: Gabe VM reserved seats, the copy-canary fleet, and Insight's Josh Osborn rule. Josh, 2026-10-29: \"Every inbox has a name. Canon that it can never have that again. If no name just send as the company. But everyone should have a name.\"";

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
    `- ${LOCKED_GENERICS_LEDGER_RULE}`,
    `- ${LOCKED_ESP_MATCH_GAP_RULE}`,
    `- ${LOCKED_REAL_PERSONA_RULE}`,
  ].join("\n");
}
