/**
 * D152 / D168 / D170 / D171 — automatic word hunt on a COPY canary fail.
 * Shadow logs the intended swap; it does not POST sequences.
 */

export type LineJob =
  | "spam-token"
  | "gift-or-experience-offer"
  | "cta"
  | "generic";

export interface CopyHuntHit {
  phrase: string;
  job: LineJob;
  swap: string;
}

const COPY_SYNONYMS: Record<string, string> = {
  free: "complimentary",
  guaranteed: "we stand behind",
  guarantee: "we stand behind",
  "act now": "when you have a minute",
  "limited time": "when you have a minute",
  "click here": "here",
  "risk-free": "no surprise",
  "risk free": "no surprise",
  winner: "",
  winners: "",
  congratulations: "",
};

const SPAM_TOKEN_KEYS = new Set(["winner", "winners", "congratulations"]);

const OFFER_NOUN_RE =
  /\b(?:air\s*pods?|airpods|tickets?|gift cards?|gifts?|jet[\s-]?skis?|round of golf|tee times?|concert tickets?)\b/i;
const SPORTS_MERGE_RE = /\{\{\s*(?:Local_Sports_Team|Team_Nickname)/i;
const POSSESSION_RE = /\b(?:i(?:'ve| have)|i've got|got|i got)\b/i;
const OFFER_BAIT_RE = /\b(?:for you|on me|yours|with your name|if you want)\b/i;
const CTA_RE =
  /\b(?:come either way|are yours either way|worth a (?:reply|chat|call)|open to connecting|book (?:here|a))\b/i;
const COMPANY_IDENTITY_RE = /\bwe(?:'re| are)\s+[A-Za-z][\w.&-]{1,}/i;

export const OFFER_LEAD_SPINTAX = "{I'd like to offer|Happy to offer}";

export function isOfferLeadSpintax(text: string): boolean {
  return /^\{\s*I'd like to offer\s*\|[^}]+\}/i.test(text.trim());
}

function isOfferLine(text: string): boolean {
  if (OFFER_NOUN_RE.test(text)) return true;
  if (SPORTS_MERGE_RE.test(text)) return true;
  if (POSSESSION_RE.test(text) && OFFER_BAIT_RE.test(text)) return true;
  return false;
}

function isCtaLine(text: string): boolean {
  if (CTA_RE.test(text)) return true;
  if (/\bps[-—:]/i.test(text) && OFFER_NOUN_RE.test(text)) return true;
  return false;
}

function extractOfferPhrase(text: string): string | undefined {
  if (SPORTS_MERGE_RE.test(text)) {
    const name = /Team_Nickname/i.test(text) ? "Team_Nickname" : "Local_Sports_Team";
    return `{{${name}}} tickets`;
  }
  const tagged = text.match(/\{\{(?:Local_Sports_Team|Team_Nickname)\}\}\s+tickets?/i);
  if (tagged) return tagged[0];
  const namedTickets = text.match(/\b(?:red sox|[A-Za-z][\w.'-]*)\s+tickets?\b/i);
  if (
    namedTickets &&
    !/^(?:extra|spare|couple|few|pair)\s+tickets?$/i.test(namedTickets[0])
  ) {
    return namedTickets[0];
  }
  const match = text.match(OFFER_NOUN_RE);
  return match?.[0];
}

function offerLead(rest: string): string {
  return `${OFFER_LEAD_SPINTAX} ${rest}`;
}

function offerSubstitute(text: string): string {
  const phrase = extractOfferPhrase(text);
  if (!phrase) return offerLead("that on me.");
  const experiential = /jet[\s-]?ski|round of golf|tee time/i.test(phrase);
  if (/air\s*pods?|airpods/i.test(phrase)) {
    return offerLead("a pair of AirPods if you would like, on me.");
  }
  if (experiential) {
    return offerLead(`a ${phrase.replace(/^a\s+/i, "")} outing on me.`);
  }
  return offerLead(`${phrase} if you're interested.`);
}

function extractCompanyBrand(text: string): string | undefined {
  const match = text.match(/\bwe(?:'re| are)\s+([A-Za-z][\w&'-]*)/i);
  return match?.[1]?.replace(/[.'\-]+$/, "").trim() || undefined;
}

export function companyIdentitySubstitute(text: string): string {
  const brand = extractCompanyBrand(text);
  if (!brand) return softenGeneric(text);
  return `so you know, we're ${brand}.`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function softenGeneric(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(COPY_SYNONYMS)) {
    if (!to) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "ig"), to);
  }
  return preferEllipsis(out.replace(/\s{2,}/g, " ").trim());
}

export function preferEllipsis(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, "... ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function flattenSpintax(text: string): string {
  let prev = "";
  let out = text;
  while (out !== prev) {
    prev = out;
    out = out.replace(/\{([^{}|]+\|[^{}]*)\}/g, (_, inner: string) => {
      const first = inner.split("|")[0]?.trim() ?? "";
      return first;
    });
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function isCompanyIdentityLine(text: string): boolean {
  return COMPANY_IDENTITY_RE.test(text);
}

export function classifyLineJob(element: string): LineJob {
  const key = element.trim().toLowerCase();
  if (SPAM_TOKEN_KEYS.has(key)) return "spam-token";
  if (Object.prototype.hasOwnProperty.call(COPY_SYNONYMS, key)) {
    return key === "click here" || key === "act now" || key === "limited time"
      ? "cta"
      : "generic";
  }
  if (isOfferLine(element)) return "gift-or-experience-offer";
  if (isCtaLine(element)) return "cta";
  return "generic";
}

export function isBannedCopySwap(swap: string): boolean {
  if (/Quick note/i.test(swap)) return true;
  if (/pen-test/i.test(swap)) return true;
  if (/from our school-district/i.test(swap)) return true;
  return false;
}

export function suggestedCopySwap(element: string): string {
  const trimmed = element.trim();
  const key = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COPY_SYNONYMS, key)) {
    return preferEllipsis(COPY_SYNONYMS[key]!);
  }
  const job = classifyLineJob(trimmed);
  if (job === "spam-token") return "";
  if (job === "gift-or-experience-offer") {
    return preferEllipsis(offerSubstitute(trimmed));
  }
  if (job === "cta") {
    return preferEllipsis(
      isOfferLine(trimmed)
        ? offerSubstitute(trimmed)
        : "Happy to send more if that would help.",
    );
  }
  if (isCompanyIdentityLine(trimmed)) {
    return preferEllipsis(companyIdentitySubstitute(trimmed));
  }
  if (trimmed.length > 40 || /\s/.test(trimmed)) {
    return preferEllipsis(softenGeneric(trimmed));
  }
  return "";
}

/** Split body into hunt slices: sentences plus known spam/gift tokens. */
export function huntCopyWords(body: string): CopyHuntHit[] {
  const hits: CopyHuntHit[] = [];
  const seen = new Set<string>();
  const push = (phrase: string) => {
    const key = phrase.trim();
    if (!key || seen.has(key.toLowerCase())) return;
    const job = classifyLineJob(key);
    let swap = suggestedCopySwap(key);
    if (isBannedCopySwap(swap)) swap = preferEllipsis(softenGeneric(key));
    if (isBannedCopySwap(swap)) swap = "";
    seen.add(key.toLowerCase());
    hits.push({ phrase: key, job, swap });
  };

  for (const token of Object.keys(COPY_SYNONYMS)) {
    const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "ig");
    if (re.test(body)) push(token);
  }

  const slices = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  for (const slice of slices) {
    const job = classifyLineJob(slice);
    if (
      job === "gift-or-experience-offer" ||
      job === "spam-token" ||
      job === "cta" ||
      isCompanyIdentityLine(slice)
    ) {
      push(slice.slice(0, 180));
    }
  }
  return hits;
}

export function wordHuntSlackPayload(hit: CopyHuntHit, campaignName: string): Record<string, unknown> {
  return {
    kind: "word_hunt",
    campaignName,
    remove: hit.phrase,
    replaceWith: hit.swap,
    job: hit.job,
    text: [
      campaignName,
      "REMOVE this exact text:",
      hit.phrase,
      "REPLACE WITH:",
      hit.swap || "(delete — pure spam token)",
    ].join("\n"),
  };
}
