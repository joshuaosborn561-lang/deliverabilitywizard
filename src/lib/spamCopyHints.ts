/**
 * Suggest concrete copy changes when placement shows mail landing in spam.
 *
 * SmartDelivery tells us *that* mail is filtered; the campaign sequence is
 * where the fix lives. Scan subject + body for common spam-filter triggers
 * and return plain-English change lines for Slack.
 */

export interface SequenceCopyInput {
  subject?: string | null;
  bodyHtml?: string | null;
}

export interface SpamCopyHint {
  /** Short label for the trigger (e.g. "gift bait"). */
  trigger: string;
  /** Snippet of the offending text (truncated). */
  found: string;
  /** What to change. */
  change: string;
}

const TRIGGER_RULES: Array<{
  trigger: string;
  pattern: RegExp;
  change: string;
}> = [
  {
    trigger: "gift / freebie bait",
    pattern:
      /\b(airpods?|free\s+(gift|pair|set)|on me| complimentary| complimentary gift)\b/i,
    change:
      "Lead with the business problem/outcome first; move any gift or AirPods offer to a later step or drop it from the cold open.",
  },
  {
    trigger: "urgency / scarcity",
    pattern:
      /\b(act now|limited time|only \d+ left|expires? (today|tonight|soon)|urgent|don't miss|last chance)\b/i,
    change:
      "Remove urgency/scarcity language — Microsoft especially treats that as promo spam.",
  },
  {
    trigger: "money / guarantee claims",
    pattern:
      /\b(guaranteed?|risk[\s-]?free|100%\s*(free|guaranteed)|no obligation|\$\d{2,}|save \$\d+)\b/i,
    change:
      "Soften hard dollar/guarantee claims; prefer a specific proof point without a splashy price comparison in the first lines.",
  },
  {
    trigger: "promo CTA phrasing",
    pattern:
      /\b(click here|buy now|order now|sign up (now|today)|claim your|congratulations|you('ve| have) (won|been selected))\b/i,
    change:
      "Replace promo CTAs with a soft question or one concrete ask (reply / 15-min call).",
  },
  {
    trigger: "ALL CAPS / hype punctuation",
    pattern: /(?=[A-Z]{6,})[A-Z]{6,}|\*{2,}|\${2,}|!{2,}|\?{2,}/,
    change:
      "Drop ALL-CAPS words and stacked !!! / $$$ — they are classic spam signals.",
  },
];

/** Strip HTML tags and collapse whitespace for scanning. */
export function plainTextFromHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Scan sequence copy and return actionable hints (deduped by trigger).
 */
export function suggestSpamCopyChanges(
  input: SequenceCopyInput,
): SpamCopyHint[] {
  const subject = String(input.subject ?? "").trim();
  const body = plainTextFromHtml(String(input.bodyHtml ?? ""));
  const haystack = `${subject}\n${body}`.trim();
  if (!haystack) return [];

  const out: SpamCopyHint[] = [];
  const seen = new Set<string>();
  for (const rule of TRIGGER_RULES) {
    const match = haystack.match(rule.pattern);
    if (!match) continue;
    if (seen.has(rule.trigger)) continue;
    seen.add(rule.trigger);
    out.push({
      trigger: rule.trigger,
      found: clip(match[0] ?? ""),
      change: rule.change,
    });
  }
  return out;
}

/**
 * Build Slack lines naming the campaign and what to change in the copy.
 */
export function formatSpamCopySlackLines(opts: {
  campaignId?: number;
  campaignName?: string;
  subject?: string;
  hints: SpamCopyHint[];
  spamPercent?: number;
}): string[] {
  const lines: string[] = [];
  const camp =
    opts.campaignId != null
      ? `*#${opts.campaignId}${opts.campaignName ? ` ${opts.campaignName}` : ""}*`
      : opts.campaignName
        ? `*${opts.campaignName}*`
        : null;

  if (camp) {
    lines.push(
      `Campaign: ${camp}${
        opts.spamPercent != null
          ? ` — *${opts.spamPercent.toFixed(1)}% spam*`
          : ""
      }`,
    );
  }

  if (opts.subject) {
    lines.push(`Subject line: “${clip(opts.subject, 100)}”`);
  }

  if (opts.hints.length) {
    lines.push("*Copy changes to make:*");
    for (const h of opts.hints) {
      lines.push(`  • *${h.trigger}* (saw “${h.found}”) — ${h.change}`);
    }
  } else if (camp) {
    lines.push(
      "*Copy changes to make:* No classic spam-trigger phrases jumped out in seq 1. Still tighten the open (shorter, less offer-forward) and A/B a plainer subject — Outlook often filters offer-heavy cold copy even without keyword hits.",
    );
  }

  return lines;
}
