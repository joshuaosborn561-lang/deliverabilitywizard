/**
 * D47 — Slack that Cayden (or Josh) reads must be plain English.
 * Logs and DECISIONS.md may keep D-numbers and jargon. Slack may not.
 */
export const SLACK_JARGON = new RegExp(
  [
    String.raw`\bD\d+\b`,
    "same-ESP",
    "staffable",
    "fan-out",
    "fan out",
    "HOLD-UNTIL",
    "HOLD recovery",
    "ESP-matched",
    "per-client A/B",
    "Fingerprint",
    String.raw`ENABLE_[A-Z_]+`,
    "SMARTLEAD_LOGIN",
    String.raw`connected\+inboxing`,
    "monthly quota",
    "min-gap",
    "Generic send rest",
    "Hold rebuild",
    "Same-client fan-out",
    String.raw`\[DRY RUN\]`,
    "sequencer",
    "Railway vars",
  ].join("|"),
  "i",
);

export function slackJargonHits(text: string): string[] {
  const hits = text.match(new RegExp(SLACK_JARGON.source, "gi")) ?? [];
  return [...new Set(hits)];
}
