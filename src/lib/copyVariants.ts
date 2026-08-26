/**
 * One-variable copy variants for a teardown. A variant that changes two
 * things is discarded, not scored (D48).
 */

export type VariantKind =
  | "word"
  | "phrase"
  | "signature_element"
  | "subject_pattern"
  | "link";

export interface CopyVariant {
  kind: VariantKind;
  element: string;
  subject: string;
  body: string;
}

export interface VariantSource {
  subject: string;
  body: string;
  flaggedTerms?: string[];
  suppressedTerms?: string[];
  controlSubject: string;
  companyName?: string;
}

const WORD_SWAPS: Array<{ term: string; swap: string }> = [
  { term: "free", swap: "complimentary" },
  { term: "guaranteed", swap: "we stand behind" },
  { term: "guarantee", swap: "we stand behind" },
  { term: "winner", swap: "" },
  { term: "congratulations", swap: "" },
  { term: "urgent", swap: "" },
  { term: "act now", swap: "when you have a minute" },
  { term: "limited time", swap: "when you have a minute" },
  { term: "click here", swap: "here" },
  { term: "risk-free", swap: "no surprise" },
  { term: "risk free", swap: "no surprise" },
];

const PHONE_RE =
  /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/g;
const LINK_RE = /https?:\/\/[^\s<]+/gi;

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function extractLinks(body: string): string[] {
  return [...new Set(body.match(LINK_RE) ?? [])];
}

export function extractPhone(body: string): string | undefined {
  return body.match(PHONE_RE)?.[0];
}

function replaceOnce(
  haystack: string,
  needle: string,
  replacement: string,
): string | undefined {
  const match = new RegExp(escapeRegExp(needle), "i").exec(haystack);
  if (!match || match.index === undefined) return undefined;
  return (
    haystack.slice(0, match.index) +
    replacement +
    haystack.slice(match.index + match[0].length)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function changedFields(
  original: { subject: string; body: string },
  next: { subject: string; body: string },
): Array<"subject" | "body"> {
  const fields: Array<"subject" | "body"> = [];
  if (original.subject !== next.subject) fields.push("subject");
  if (original.body !== next.body) fields.push("body");
  return fields;
}

export function isSingleVariable(
  original: { subject: string; body: string },
  next: { subject: string; body: string },
): boolean {
  return changedFields(original, next).length === 1;
}

function pushIfSingle(
  out: CopyVariant[],
  original: { subject: string; body: string },
  next: CopyVariant,
): void {
  if (!isSingleVariable(original, next)) return;
  if (next.subject === original.subject && next.body === original.body) return;
  const key = `${next.kind}:${next.element.toLowerCase()}`;
  if (out.some((row) => `${row.kind}:${row.element.toLowerCase()}` === key)) {
    return;
  }
  out.push(next);
}

export function generateCopyVariants(source: VariantSource): CopyVariant[] {
  const original = { subject: source.subject, body: source.body };
  const out: CopyVariant[] = [];
  const terms = uniqueTerms([
    ...(source.flaggedTerms ?? []),
    ...(source.suppressedTerms ?? []),
    ...WORD_SWAPS.map((row) => row.term),
  ]);

  for (const term of terms) {
    const swap =
      WORD_SWAPS.find((row) => row.term === term.toLowerCase())?.swap ?? "";
    const nextBody = replaceOnce(source.body, term, swap);
    if (nextBody === undefined) continue;
    pushIfSingle(out, original, {
      kind: term.includes(" ") ? "phrase" : "word",
      element: term,
      subject: source.subject,
      body: nextBody,
    });
  }

  const sentences = source.body
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 20);
  for (const sentence of sentences) {
    const nextBody = replaceOnce(source.body, sentence, "");
    if (nextBody === undefined) continue;
    pushIfSingle(out, original, {
      kind: "phrase",
      element: sentence.slice(0, 80),
      subject: source.subject,
      body: nextBody.replace(/\n{3,}/g, "\n\n").trim(),
    });
  }

  const phone = extractPhone(source.body);
  if (phone) {
    const nextBody = replaceOnce(source.body, phone, "");
    if (nextBody !== undefined) {
      pushIfSingle(out, original, {
        kind: "signature_element",
        element: "phone",
        subject: source.subject,
        body: nextBody,
      });
    }
  }

  const company = source.companyName?.trim();
  if (company) {
    const nextBody = replaceOnce(source.body, company, "");
    if (nextBody !== undefined) {
      pushIfSingle(out, original, {
        kind: "signature_element",
        element: "company_name",
        subject: source.subject,
        body: nextBody,
      });
    }
  }

  if (source.subject.trim() && source.subject !== source.controlSubject) {
    pushIfSingle(out, original, {
      kind: "subject_pattern",
      element: source.subject,
      subject: source.controlSubject,
      body: source.body,
    });
  }

  for (const link of extractLinks(source.body)) {
    const nextBody = replaceOnce(source.body, link, "");
    if (nextBody === undefined) continue;
    pushIfSingle(out, original, {
      kind: "link",
      element: link,
      subject: source.subject,
      body: nextBody,
    });
  }

  return out;
}

export function rankVariants(
  variants: CopyVariant[],
  preferred: string[],
  cap: number,
): CopyVariant[] {
  if (cap <= 0) return [];
  const preferredLower = preferred.map((term) => term.toLowerCase());
  const scored = variants.map((variant, index) => {
    const hit = preferredLower.findIndex((term) =>
      variant.element.toLowerCase().includes(term),
    );
    return { variant, index, rank: hit === -1 ? 1000 + index : hit };
  });
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.slice(0, cap).map((row) => row.variant);
}

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
