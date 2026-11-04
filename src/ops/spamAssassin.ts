/**
 * Local SpamAssassin score for a proposed copy change.
 *
 * Weights are the first (local: no Bayes, no network) number in Apache
 * SpamAssassin trunk `rules/50_scores.cf`. Only rules we can evaluate
 * from the copy text are included. A note that hits none of them scores
 * 0. Approval of a copy change is allowed only at score 0.
 */

export interface SpamAssassinHit {
  rule: string;
  score: number;
}

export interface SpamAssassinScore {
  score: number;
  hits: SpamAssassinHit[];
}

interface Rule {
  rule: string;
  score: number;
  test: (text: string) => boolean;
}

const RULES: readonly Rule[] = [
  {
    rule: "SUBJ_ALL_CAPS",
    score: 0.5,
    test: (text) => {
      const subject = text.match(/^subject:\s*(.+)$/im)?.[1]?.trim() ?? "";
      const candidate =
        subject ||
        (text.length >= 8 && !text.includes("\n") ? text.trim() : "");
      const letters = candidate.replace(/[^A-Za-z]/g, "");
      return letters.length >= 8 && letters === letters.toUpperCase();
    },
  },
  {
    rule: "DEAR_FRIEND",
    score: 2.683,
    test: (text) => /\bdear friend\b/i.test(text),
  },
  {
    rule: "BANG_GUAR",
    score: 1,
    test: (text) => /!/.test(text) && /\bguarantee[ds]?\b/i.test(text),
  },
  {
    rule: "GUARANTEED_100_PERCENT",
    score: 2.699,
    test: (text) =>
      /100\s*%\s*guarantee[ds]?|guarantee[ds]?\s*100\s*%/i.test(text),
  },
  {
    rule: "URG_BIZ",
    score: 1.75,
    test: (text) =>
      /\burgent\b/i.test(text) && /\b(?:business|proposal|response)\b/i.test(text),
  },
  {
    rule: "EXCUSE_REMOVE",
    score: 2.907,
    test: (text) =>
      /\b(?:to be removed|remove me|click here to unsubscribe)\b/i.test(text),
  },
  {
    rule: "FREE_QUOTE_INSTANT",
    score: 2.7,
    test: (text) => /\bfree quote\b/i.test(text) && /\binstant\b/i.test(text),
  },
  {
    rule: "IMPOTENCE",
    score: 1.539,
    test: (text) => /\b(?:viagra|cialis|impotence)\b/i.test(text),
  },
  {
    rule: "NO_PRESCRIPTION",
    score: 1.915,
    test: (text) => /\bno prescription\b/i.test(text),
  },
  {
    rule: "PLING_QUERY",
    score: 0.1,
    test: (text) => /!\?|\?!/.test(text),
  },
  {
    rule: "REMOVE_BEFORE_LINK",
    score: 0.1,
    test: (text) => /\bremove\b/i.test(text) && /https?:\/\//i.test(text),
  },
];

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function scoreSpamAssassin(text: string): SpamAssassinScore {
  const body = String(text ?? "");
  const hits: SpamAssassinHit[] = [];
  let score = 0;
  for (const rule of RULES) {
    if (!rule.test(body)) continue;
    hits.push({ rule: rule.rule, score: rule.score });
    score += rule.score;
  }
  return { score: round3(score), hits };
}

/** True when the copy change must not be approved. */
export function spamAssassinBlocksApproval(score: number): boolean {
  return round3(score) !== 0;
}

/** Proposed replacement text on a swap_copy ask. */
export function copyChangeText(detail: Record<string, unknown> | null | undefined): string {
  if (!detail) return "";
  const parts = [detail.subject, detail.swap, detail.replacement, detail.body]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return parts.join("\n");
}
