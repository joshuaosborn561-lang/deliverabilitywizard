import type { SlackClient } from "../clients/slack.js";
import type {
  IsolationActionKind,
  IsolationActionRecord,
} from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";

export function buildIsolationAction(input: {
  kind: IsolationActionKind;
  title: string;
  proof: string;
  detail: Record<string, unknown>;
  now?: string;
}): IsolationActionRecord {
  const now = input.now ?? new Date().toISOString();
  return {
    id: `${input.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind,
    status: "pending",
    title: input.title,
    proof: input.proof,
    detail: input.detail,
    allowed:
      input.kind === "swap_copy" || input.kind === "add_signature_tag"
        ? "owner_or_operator"
        : "owner",
    requestedAt: now,
  };
}

function samePending(
  existing: IsolationActionRecord,
  next: IsolationActionRecord,
): boolean {
  if (existing.kind !== next.kind) return false;
  // buy_canary_fleet and add_signature_tag look at non-pending history
  // (already bought / recently executed / recently denied) in their branches.
  if (
    next.kind !== "buy_canary_fleet" &&
    next.kind !== "buy_isolation_domain" &&
    next.kind !== "add_signature_tag" &&
    existing.status !== "pending"
  ) {
    return false;
  }
  if (next.kind === "swap_copy") {
    // D133 — the tap applies fleet-wide, so one pending ask per word is
    // enough no matter which campaign isolated it.
    return (
      String(existing.detail.element ?? "").toLowerCase() ===
      String(next.detail.element ?? "").toLowerCase()
    );
  }
  if (next.kind === "generic_backfill") {
    return (
      Number(existing.detail.campaignId) === Number(next.detail.campaignId) &&
      (existing.status === "pending" ||
        existing.status === "approved" ||
        existing.status === "executed")
    );
  }
  if (next.kind === "buy_isolation_domain") {
    // D137 — the rig asks once, ever: any prior answer (including a deny)
    // stands. Josh reverses a deny by saying so, not by being re-asked
    // every monitor pass.
    return true;
  }
  if (next.kind === "buy_canary_fleet") {
    return (
      existing.status === "pending" ||
      existing.status === "approved" ||
      existing.status === "executed"
    );
  }
  return (
    String(existing.detail.domain ?? "").toLowerCase() ===
    String(next.detail.domain ?? "").toLowerCase()
  );
}

/**
 * D146/D148 refinement — a domain retired in the last week keeps bouncing
 * stale pre-retire sends into the ledger; those samples must not re-open
 * a "Retire X" ask for a domain that is already retired (live 22:10Z on
 * 8/27: techevolutionhub.info got a second ask two hours after Josh
 * executed its first).
 */
export function domainRecentlyRetired(
  store: StateStore,
  domain: string,
  now = Date.now(),
): boolean {
  return store.listIsolationActions().some(
    (row) =>
      row.kind === "retire_domain" &&
      row.status === "executed" &&
      String(row.detail.domain ?? "").toLowerCase() === domain.toLowerCase() &&
      now - Date.parse(String(row.executedAt ?? row.decidedAt ?? "")) <
        7 * 24 * 60 * 60 * 1000,
  );
}

export async function requestIsolationAction(input: {
  store: StateStore;
  slack: Pick<SlackClient, "notifyIsolationAction">;
  action: IsolationActionRecord;
}): Promise<IsolationActionRecord | null> {
  const existing = input.store
    .listIsolationActions()
    .find((row) => samePending(row, input.action));
  if (existing) return null;
  input.store.upsertIsolationAction(input.action);
  await notifyIsolationActionRecord(input.slack, input.action);
  return input.action;
}

export async function notifyIsolationActionRecord(
  slack: Pick<SlackClient, "notifyIsolationAction">,
  action: IsolationActionRecord,
): Promise<void> {
  await slack.notifyIsolationAction({
    title: action.title,
    proof: action.proof,
    actionId: action.id,
    kind: action.kind,
    who:
      action.kind === "swap_copy" || action.kind === "add_signature_tag"
        ? "Josh or Cayden"
        : "Josh",
    element:
      typeof action.detail.element === "string" ? action.detail.element : undefined,
    suggestedSwap:
      typeof action.detail.swap === "string" ? action.detail.swap : undefined,
    campaignName:
      typeof action.detail.campaignName === "string"
        ? action.detail.campaignName
        : undefined,
  });
}

/**
 * D97 — leftover Add %signature% buttons are retired. The checker writes
 * the tag (D92). A deploy remind must not re-post them.
 */
export function dismissPendingSignatureAsks(
  store: StateStore,
  now = new Date().toISOString(),
): number {
  let dismissed = 0;
  for (const action of store.listIsolationActions()) {
    if (action.kind !== "add_signature_tag") continue;
    if (action.status !== "pending") continue;
    store.upsertIsolationAction({
      ...action,
      status: "denied",
      decidedAt: now,
      decidedBy: "system",
      error: "Signatures write themselves (D92). Slack ask retired (D97).",
    });
    dismissed += 1;
  }
  return dismissed;
}

/** Re-send Slack buttons for pending asks. Does not create or approve anything. */
export async function remindPendingIsolationActions(input: {
  store: StateStore;
  slack: Pick<SlackClient, "notifyIsolationAction">;
}): Promise<number> {
  dismissPendingSignatureAsks(input.store);
  const pending = input.store.pendingIsolationActions();
  const boughtCanary = input.store
    .listIsolationActions()
    .some(
      (row) =>
        row.kind === "buy_canary_fleet" &&
        (row.status === "approved" || row.status === "executed"),
    );
  let posted = 0;
  for (const action of pending) {
    if (action.kind === "buy_canary_fleet" && boughtCanary) continue;
    if (action.kind === "add_signature_tag") continue;
    await notifyIsolationActionRecord(input.slack, action);
    posted += 1;
  }
  return posted;
}

/** D87 — the campaign ids a signature ask covers (single or bulk). */
export function signatureCampaignIdsOf(action: {
  detail: Record<string, unknown>;
}): number[] {
  const ids: number[] = [];
  const single = Number(action.detail.campaignId);
  if (Number.isFinite(single) && single > 0) ids.push(single);
  if (Array.isArray(action.detail.campaignIds)) {
    for (const raw of action.detail.campaignIds) {
      const id = Number(raw);
      if (Number.isFinite(id) && id > 0 && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * D152 / D168 — the job a hunted line is doing. D152 said the Slack
 * substitute must keep that job; D168 names the jobs so an offer opener
 * cannot fall through to a blank softener or another client's pitch.
 */
export type LineJob =
  | "spam-token"
  | "gift-or-experience-offer"
  | "cta"
  | "generic";

export type SuggestedCopySwapOpts = {
  /** Fuller subject+body so an 80-char hunt slice can still see the offer. */
  context?: string;
  campaignName?: string;
  client?: string;
};

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

/** Physical gifts + experiential offers. "weekend" alone is not an offer. */
const OFFER_NOUN_RE =
  /\b(?:air\s*pods?|airpods|tickets?|gift cards?|gifts?|jet[\s-]?skis?|round of golf|tee times?|concert tickets?)\b/i;

const POSSESSION_RE =
  /\b(?:i(?:'ve| have)|i've got|got|i got)\b/i;

const OFFER_BAIT_RE =
  /\b(?:for you|on me|yours|with your name|if you want)\b/i;

const CTA_RE =
  /\b(?:come either way|are yours either way|worth a (?:reply|chat|call)|open to connecting|book (?:here|a))\b/i;

/**
 * Expand a hunt slice to the surrounding sentence when the body is
 * available — generateCopyVariants used to label only slice(0, 80).
 */
export function resolveSwapText(element: string, context?: string): string {
  const trimmed = element.trim();
  if (!context?.trim()) return trimmed;
  const idx = context.toLowerCase().indexOf(trimmed.toLowerCase());
  if (idx < 0) return trimmed;
  const start = sentenceStart(context, idx);
  const end = sentenceEnd(context, idx + trimmed.length);
  const sentence = context.slice(start, end).trim();
  return sentence.length >= trimmed.length ? sentence : trimmed;
}

function sentenceStart(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    if (text[i] === "\n") return i + 1;
    if (
      (text[i] === "." || text[i] === "!" || text[i] === "?") &&
      /\s/.test(text[i + 1] ?? " ")
    ) {
      return i + 1;
    }
  }
  return 0;
}

function sentenceEnd(text: string, index: number): number {
  for (let i = index; i < text.length; i++) {
    if (text[i] === "\n") return i;
    if (
      (text[i] === "." || text[i] === "!" || text[i] === "?") &&
      (i === text.length - 1 || /\s/.test(text[i + 1] ?? ""))
    ) {
      return i + 1;
    }
  }
  return text.length;
}

export function classifyLineJob(
  element: string,
  opts?: SuggestedCopySwapOpts,
): LineJob {
  const key = element.trim().toLowerCase();
  if (SPAM_TOKEN_KEYS.has(key)) return "spam-token";
  if (Object.prototype.hasOwnProperty.call(COPY_SYNONYMS, key)) {
    return key === "click here" || key === "act now" || key === "limited time"
      ? "cta"
      : "generic";
  }
  const text = resolveSwapText(element, opts?.context);
  if (isOfferLine(text)) return "gift-or-experience-offer";
  if (isCtaLine(text)) return "cta";
  return "generic";
}

function isOfferLine(text: string): boolean {
  if (OFFER_NOUN_RE.test(text)) return true;
  // Possession + bait without a known noun ("I've got something for you").
  if (POSSESSION_RE.test(text) && OFFER_BAIT_RE.test(text)) return true;
  return false;
}

function isCtaLine(text: string): boolean {
  if (CTA_RE.test(text)) return true;
  if (/\bps[-—:]/i.test(text) && OFFER_NOUN_RE.test(text)) return true;
  return false;
}

function extractOfferPhrase(text: string): string | undefined {
  const tagged = text.match(
    /\{\{(?:Local_Sports_Team|Team_Nickname)\}\}\s+tickets?/i,
  );
  if (tagged) return tagged[0];
  const namedTickets = text.match(/\b(?:red sox|[A-Za-z][\w.'-]*)\s+tickets?\b/i);
  if (namedTickets && !/^(?:extra|spare|couple|few|pair)\s+tickets?$/i.test(namedTickets[0])) {
    return namedTickets[0];
  }
  const match = text.match(OFFER_NOUN_RE);
  return match?.[0];
}

function offerSubstitute(text: string): string {
  const phrase = extractOfferPhrase(text);
  if (!phrase) return "Happy to send that if useful.";
  const experiential = /jet[\s-]?ski|round of golf|tee time/i.test(phrase);
  if (/air\s*pods?|airpods/i.test(phrase)) {
    return "Happy to send a pair of AirPods if useful.";
  }
  if (experiential) {
    return `Happy to offer a ${phrase.replace(/^a\s+/i, "")} outing if useful.`;
  }
  return `Happy to send ${phrase} if useful.`;
}

function ctaSubstitute(text: string): string {
  if (isOfferLine(text)) return offerSubstitute(text);
  return "Happy to send more if useful.";
}

function softenGeneric(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(COPY_SYNONYMS)) {
    if (!to) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "ig"), to);
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * D152 / D168 — propose a substitute that still does the job of the line
 * and stayed (or should stay) out of spam. Blank delete is a last resort
 * for pure spam tokens (winner / congratulations), never the default for
 * an opener, offer, or CTA the campaign still needs.
 *
 * Offer openers keep the gift / tickets / jet-ski / AirPods intent and
 * drop bait phrasing. The school-district pen-test bridge is retired —
 * it was Goliath copy applied to every client. "Quick note —" is not a
 * default for offer or opener jobs.
 */
export function suggestedCopySwap(
  element: string,
  opts?: SuggestedCopySwapOpts,
): string {
  const trimmed = element.trim();
  const key = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COPY_SYNONYMS, key)) {
    return COPY_SYNONYMS[key]!;
  }

  const text = resolveSwapText(trimmed, opts?.context);
  const job = classifyLineJob(trimmed, opts);

  if (job === "spam-token") return "";
  if (job === "gift-or-experience-offer") return offerSubstitute(text);
  if (job === "cta") return ctaSubstitute(text);

  // Generic: keep the line, lightly softened. Never "Quick note —" and
  // never another client's pitch.
  if (trimmed.length > 40 || /\s/.test(trimmed)) {
    return softenGeneric(text);
  }
  return "";
}
