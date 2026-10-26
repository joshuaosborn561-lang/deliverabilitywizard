/**
 * D303 — mailbox rest-then-burn (LOCKED canon, Josh 2026-10-25).
 *
 * When isolation shows the MAILBOX (not the copy) is the cause — its
 * same-ESP placement reads under 80% — the mailbox is pulled from its POD
 * and campaigns, keeps warmup ON, and rests 14 days. A free warm generic
 * from the Generics Ledger covers the seat (client, POD, covering_for).
 * After 14 days it goes back automatically and the generic comes out,
 * the same way the warm-swap does. A mailbox that reads under 80% again
 * after going back on, or whose rest_count passes 3, is BURNED: pulled
 * permanently with a retire/replace request. Replacement spend needs
 * approval.
 */

export const MAILBOX_REST_DAYS = 14;
export const MAILBOX_REST_SAME_ESP_FLOOR = 80;
export const MAILBOX_REST_MAX_COUNT = 3;

export type MailboxRestStatus = "resting" | "returned" | "burned";

export interface MailboxRestEvent {
  restedAt: string;
  returnedAt: string | null;
  sameEspInbox: number | null;
  coveringGeneric: string | null;
}

export interface MailboxRestRecord {
  email: string;
  accountId: number | null;
  clientId: number;
  pod: "A" | "B";
  status: MailboxRestStatus;
  restCount: number;
  restUntil: string | null;
  removedFromCampaigns: number[];
  coveringGeneric: string | null;
  history: MailboxRestEvent[];
  burnedAt: string | null;
  burnReason: string | null;
  /** Set when the approved retire_mailbox ask executed. */
  retiredAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function mailboxIsCause(input: {
  verdict: string;
  sameEspInbox: number | null | undefined;
  scoredSameEsp?: boolean;
}): boolean {
  if (input.verdict !== "INFRA") return false;
  if (input.scoredSameEsp === false) return false;
  return (
    typeof input.sameEspInbox === "number" &&
    input.sameEspInbox < MAILBOX_REST_SAME_ESP_FLOOR
  );
}

export type RestDecision =
  | { action: "rest"; record: MailboxRestRecord }
  | { action: "burn"; record: MailboxRestRecord }
  | { action: "none"; reason: string };

/** Decide what a mailbox-is-the-cause reading does to a mailbox. */
export function decideRest(input: {
  email: string;
  accountId: number | null;
  clientId: number;
  pod: "A" | "B";
  sameEspInbox: number;
  campaignIds: number[];
  existing?: MailboxRestRecord;
  now?: Date;
}): RestDecision {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const prior = input.existing;
  if (prior?.status === "burned") return { action: "none", reason: "already burned" };
  if (prior?.status === "resting") return { action: "none", reason: "already resting" };
  const base: MailboxRestRecord = prior ?? {
    email,
    accountId: input.accountId,
    clientId: input.clientId,
    pod: input.pod,
    status: "returned",
    restCount: 0,
    restUntil: null,
    removedFromCampaigns: [],
    coveringGeneric: null,
    history: [],
    burnedAt: null,
    burnReason: null,
  };
  // Under 80% again after going back on → BURNED.
  if (prior && prior.status === "returned" && prior.restCount > 0) {
    return {
      action: "burn",
      record: {
        ...base,
        status: "burned",
        removedFromCampaigns: input.campaignIds,
        burnedAt: now.toISOString(),
        burnReason: `read ${input.sameEspInbox.toFixed(0)}% same-ESP after returning from rest`,
      },
    };
  }
  const restCount = base.restCount + 1;
  if (restCount > MAILBOX_REST_MAX_COUNT) {
    return {
      action: "burn",
      record: {
        ...base,
        restCount,
        status: "burned",
        removedFromCampaigns: input.campaignIds,
        burnedAt: now.toISOString(),
        burnReason: `rest_count ${restCount} is over ${MAILBOX_REST_MAX_COUNT}`,
      },
    };
  }
  return {
    action: "rest",
    record: {
      ...base,
      accountId: input.accountId ?? base.accountId,
      clientId: input.clientId,
      pod: input.pod,
      status: "resting",
      restCount,
      restUntil: new Date(now.getTime() + MAILBOX_REST_DAYS * DAY_MS).toISOString(),
      removedFromCampaigns: input.campaignIds,
      coveringGeneric: null,
      history: [
        ...base.history,
        {
          restedAt: now.toISOString(),
          returnedAt: null,
          sameEspInbox: input.sameEspInbox,
          coveringGeneric: null,
        },
      ],
    },
  };
}

/** Rests whose 14 days are up. */
export function restsDueBack(
  records: MailboxRestRecord[],
  now: Date = new Date(),
): MailboxRestRecord[] {
  return records.filter(
    (r) =>
      r.status === "resting" &&
      r.restUntil !== null &&
      Date.parse(r.restUntil) <= now.getTime(),
  );
}

export function markReturned(
  record: MailboxRestRecord,
  now: Date = new Date(),
): MailboxRestRecord {
  const history = record.history.map((e, i) =>
    i === record.history.length - 1 && !e.returnedAt
      ? { ...e, returnedAt: now.toISOString() }
      : e,
  );
  return { ...record, status: "returned", restUntil: null, coveringGeneric: null, history };
}

export function withCoveringGeneric(
  record: MailboxRestRecord,
  generic: string | null,
): MailboxRestRecord {
  const history = record.history.map((e, i) =>
    i === record.history.length - 1 ? { ...e, coveringGeneric: generic } : e,
  );
  return { ...record, coveringGeneric: generic, history };
}

/** Covering-for row the Generics Ledger records for a resting seat. */
export function restCoveringFor(record: MailboxRestRecord): {
  email: string;
  warmReadyAt: string | null;
} {
  return { email: record.email, warmReadyAt: record.restUntil };
}

/** Plain-English Slack line for a rest / burn. */
export function restAlertText(
  decision: Exclude<RestDecision, { action: "none" }>,
): string {
  const r = decision.record;
  if (decision.action === "burn") {
    return `:fire: *${r.email} is BURNED* (${r.burnReason}). Pulled for good. A retire/replace request is raised; any replacement spend needs approval.`;
  }
  return `:zzz: *${r.email} is resting 14 days* (rest ${r.restCount} of ${MAILBOX_REST_MAX_COUNT}). Same-ESP placement read under ${MAILBOX_REST_SAME_ESP_FLOOR}%, and isolation shows the mailbox, not the copy, is the cause. Warmup stays on; a warm generic covers its seat. It goes back on ${r.restUntil?.slice(0, 10)}.`;
}
