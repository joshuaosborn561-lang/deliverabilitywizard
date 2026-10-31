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
export const LOCKED_PER_VARIANT_TESTS_RULE =
  "Per-variant tests (D303): every A/B variant of every campaign gets its own placement test and its own canary-copy test, never one test per campaign.";

export const LOCKED_ESP_REBALANCE_RULE =
  "ESP mix (D303): an on-week POD off the client's InboxKit Microsoft share is auto-rebalanced, not only reported, using only swaps canon already allows: warm mailboxes, the same client, generics from the Generics Ledger; every swap is 1-for-1 so POD-40 never drops.";

export const LOCKED_SEND_WINDOW_RULE =
  "Send windows (D303): every campaign sends Mon–Thu 8am–7pm America/New_York; automation converges any campaign that drifts and keeps its own send gap and daily cap.";

export const LOCKED_MAILBOX_REST_RULE =
  "Mailbox rest (D303): when isolation shows the mailbox, not the copy, is the cause (same-ESP placement under 80%), the mailbox is pulled from its POD and campaigns, keeps warmup on, and rests 28 days (4 weeks); a free warm generic covers its seat, recorded in the Generics Ledger with client, POD and covering_for, and stays until day 28. After 28 days the mailbox goes back automatically and the generic comes out, the same way as the warm-swap. Every mailbox keeps a rest_count and rest history. It is BURNED if it reads under 80% again after going back on, or if rest_count goes over 3: pulled permanently and a retire/replace request is raised; any replacement spend needs approval. This replaces kill-only (D51/D128) for this case only.";

export const LOCKED_REPLY_RATE_DROP_RULE =
  "Reply-rate drop (D311): a sending domain is flagged when its trailing 7-day reply rate, with at least 150 sends in that window, is 40% or more below its client's baseline, the client's trailing 30-day reply rate across ACTIVE campaigns. Alert only: Josh is alerted, then one placement test runs on that domain only. It never pulls, rests, pauses or isolation-tests anything, and it sits on top of the placement gates, not in place of them.";

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
    `- ${LOCKED_PER_VARIANT_TESTS_RULE}`,
    `- ${LOCKED_ESP_REBALANCE_RULE}`,
    `- ${LOCKED_SEND_WINDOW_RULE}`,
    `- ${LOCKED_MAILBOX_REST_RULE}`,
    `- ${LOCKED_REPLY_RATE_DROP_RULE}`,
  ].join("\n");
}
