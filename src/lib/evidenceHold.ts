/**
 * D224 — every hold is evidence-per-seat. A request names each seat
 * and attaches that seat's own reason from the fixed list. Pattern,
 * substring, and client-wide holds are refused. Expiry is when the
 * reason clears, or 30 days at most.
 */

import { isSurblListing } from "./blacklistIgnore.js";
import { emailDomainOf } from "./isolationDomain.js";

export const EVIDENCE_HOLD_MAX_DAYS = 30;
export const EVIDENCE_HOLD_MAX_MS = EVIDENCE_HOLD_MAX_DAYS * 24 * 60 * 60 * 1000;
export const EVIDENCE_HOLD_WARMUP_DAYS = 21;
export const EVIDENCE_HOLD_WARMUP_REPUTATION_THRESHOLD = 80;

export const EVIDENCE_HOLD_REASONS = [
  "hard_bounce_or_block",
  "auth_failure",
  "retired_or_bad_sender_domain",
  "inboxkit_lapsed",
  "blacklist_hit",
  "warmup_short_or_low_rep",
] as const;

export type EvidenceHoldReason = (typeof EVIDENCE_HOLD_REASONS)[number];

export const REFUSED_HOLD_MATCH_KINDS = [
  "pattern",
  "substring",
  "client",
  "regex",
] as const;

export type RefusedHoldMatchKind = (typeof REFUSED_HOLD_MATCH_KINDS)[number];

export type HoldMatchKind = "email" | "domain" | RefusedHoldMatchKind;

export const INBOXKIT_LAPSED_STATUSES = [
  "lapsed",
  "cancelled",
  "inactive",
] as const;

export type InboxkitLapsedStatus = (typeof INBOXKIT_LAPSED_STATUSES)[number];

export interface EvidenceHoldPayload {
  eventId?: string;
  smtpCode?: string;
  tenant?: string;
  authKind?: "smtp" | "imap";
  domain?: string;
  inboxkitStatus?: string;
  blacklistList?: string;
  warmupDays?: number;
  warmupReputation?: number;
  pattern?: string;
}

export interface SeatHoldRequest {
  email: string;
  accountId?: number;
  domain?: string;
  reason: EvidenceHoldReason | string;
  evidence?: EvidenceHoldPayload | null;
  expiresAt?: string | Date;
  source?: string;
  matchKind?: HoldMatchKind | string;
}

export interface EvidenceHoldRecord {
  email: string;
  accountId?: number;
  domain: string;
  reason: EvidenceHoldReason;
  evidence: EvidenceHoldPayload;
  heldAt: string;
  expiresAt: string;
  source: string;
  tagName: string;
}

export interface RejectedHoldSeat {
  email: string;
  accountId?: number;
  rejectReason: string;
}

export interface EvidenceHoldGateResult {
  accepted: EvidenceHoldRecord[];
  rejected: RejectedHoldSeat[];
}

export interface EvidenceHoldContext {
  retiredDomains?: Iterable<string>;
  badSenderDomains?: Iterable<string>;
  now?: Date;
}

const SMTP_CODE_RE = /\b(\d\.\d{1,3}\.\d{1,3})\b/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeHost(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

function hostSet(values: Iterable<string> | undefined): Set<string> {
  return new Set(
    [...(values ?? [])].map(normalizeHost).filter((host) => host.length > 0),
  );
}

function isRefusedMatchKind(kind: string | undefined): kind is RefusedHoldMatchKind {
  return (REFUSED_HOLD_MATCH_KINDS as readonly string[]).includes(kind ?? "");
}

function looksLikePattern(value: string): boolean {
  return /[*?^$()[\]{}|\\]/.test(value) || value.includes(" ");
}

export function extractSmtpCode(value: string | null | undefined): string | null {
  const match = SMTP_CODE_RE.exec(String(value ?? ""));
  return match?.[1] ?? null;
}

export function isHardBounceSmtpCode(code: string | null | undefined): boolean {
  const smtp = extractSmtpCode(code) ?? String(code ?? "").trim();
  return /^[45]\.\d{1,3}\.\d{1,3}$/.test(smtp);
}

export function holdExpiresAt(now: Date, requested?: string | Date): Date {
  const cap = new Date(now.getTime() + EVIDENCE_HOLD_MAX_MS);
  if (requested == null) return cap;
  const at =
    requested instanceof Date ? requested : new Date(Date.parse(String(requested)));
  if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) return cap;
  return at.getTime() > cap.getTime() ? cap : at;
}

export function holdUntilTagName(expiresAt: Date): string {
  return `HOLD-UNTIL-${expiresAt.toISOString().slice(0, 10)}`;
}

export function evidenceHoldStillActive(
  record: Pick<EvidenceHoldRecord, "expiresAt">,
  now = new Date(),
): boolean {
  const at = Date.parse(record.expiresAt);
  return Number.isFinite(at) && now.getTime() < at;
}

export function evidenceHoldReasonCleared(
  record: EvidenceHoldRecord,
  current: EvidenceHoldContext = {},
): boolean {
  if (record.reason === "retired_or_bad_sender_domain") {
    const retired = hostSet(current.retiredDomains);
    const bad = hostSet(current.badSenderDomains);
    return !retired.has(record.domain) && !bad.has(record.domain);
  }
  return false;
}

function reject(
  email: string,
  accountId: number | undefined,
  rejectReason: string,
): RejectedHoldSeat {
  return { email, accountId, rejectReason };
}

function qualifySeat(
  request: SeatHoldRequest,
  now: Date,
  retired: Set<string>,
  badSender: Set<string>,
): EvidenceHoldRecord | RejectedHoldSeat {
  const email = normalizeEmail(request.email);
  const accountId =
    typeof request.accountId === "number" && request.accountId > 0
      ? request.accountId
      : undefined;

  if (!email || !EMAIL_RE.test(email)) {
    return reject(email || String(request.email ?? ""), accountId, "seat is not named");
  }
  if (isRefusedMatchKind(request.matchKind)) {
    return reject(
      email,
      accountId,
      `held by ${request.matchKind}, not this seat's own evidence`,
    );
  }
  if (request.evidence?.pattern) {
    return reject(email, accountId, "substring or pattern matches are refused");
  }

  const seatDomain = emailDomainOf(email);
  if (!seatDomain) {
    return reject(email, accountId, "seat is not named");
  }
  const claimedDomain = request.domain ? normalizeHost(request.domain) : "";
  if (claimedDomain && claimedDomain !== seatDomain) {
    return reject(email, accountId, "domain must match this seat exactly");
  }
  if (claimedDomain && looksLikePattern(claimedDomain)) {
    return reject(email, accountId, "substring or pattern matches are refused");
  }

  if (!(EVIDENCE_HOLD_REASONS as readonly string[]).includes(request.reason)) {
    return reject(email, accountId, "reason is not on the fixed list");
  }
  const reason = request.reason as EvidenceHoldReason;
  const evidence = request.evidence ?? {};
  const fail = qualifyEvidence(reason, email, seatDomain, evidence, retired, badSender);
  if (fail) return reject(email, accountId, fail);

  const expires = holdExpiresAt(now, request.expiresAt);
  return {
    email,
    accountId,
    domain: seatDomain,
    reason,
    evidence: { ...evidence },
    heldAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    source: String(request.source ?? "hold-request").trim() || "hold-request",
    tagName: holdUntilTagName(expires),
  };
}

function qualifyEvidence(
  reason: EvidenceHoldReason,
  email: string,
  seatDomain: string,
  evidence: EvidenceHoldPayload,
  retired: Set<string>,
  badSender: Set<string>,
): string | null {
  switch (reason) {
    case "hard_bounce_or_block": {
      const eventId = String(evidence.eventId ?? "").trim();
      if (!eventId) return "hard bounce or block needs the event id";
      const smtp = extractSmtpCode(evidence.smtpCode) ?? String(evidence.smtpCode ?? "").trim();
      if (!isHardBounceSmtpCode(smtp)) {
        return "hard bounce or block needs the SMTP code";
      }
      const tenant = normalizeHost(evidence.tenant);
      if (tenant && tenant !== seatDomain && tenant !== email) {
        return "bounce event is not on this mailbox or its tenant";
      }
      return null;
    }
    case "auth_failure": {
      if (evidence.authKind !== "smtp" && evidence.authKind !== "imap") {
        return "auth failure must be SMTP or IMAP on this account";
      }
      return null;
    }
    case "retired_or_bad_sender_domain": {
      const domain = normalizeHost(evidence.domain) || seatDomain;
      if (!domain || domain !== seatDomain) {
        return "retired domain must match this seat exactly";
      }
      if (looksLikePattern(domain)) {
        return "substring or pattern matches are refused";
      }
      if (!retired.has(domain) && !badSender.has(domain)) {
        return "domain is not retired or marked as a bad sender";
      }
      return null;
    }
    case "inboxkit_lapsed": {
      const status = String(evidence.inboxkitStatus ?? "")
        .trim()
        .toLowerCase();
      if (!(INBOXKIT_LAPSED_STATUSES as readonly string[]).includes(status)) {
        return "InboxKit seat is not lapsed, cancelled, or inactive";
      }
      return null;
    }
    case "blacklist_hit": {
      const list = String(evidence.blacklistList ?? "").trim();
      if (!list) return "blacklist hit needs the list name";
      if (isSurblListing(list)) return "SURBL is never a blacklist hit";
      const domain = normalizeHost(evidence.domain) || seatDomain;
      if (domain !== seatDomain) {
        return "blacklist domain must match this seat exactly";
      }
      return null;
    }
    case "warmup_short_or_low_rep": {
      const days =
        typeof evidence.warmupDays === "number" && Number.isFinite(evidence.warmupDays)
          ? evidence.warmupDays
          : null;
      const rep =
        typeof evidence.warmupReputation === "number" &&
        Number.isFinite(evidence.warmupReputation)
          ? evidence.warmupReputation
          : null;
      const short = days != null && days < EVIDENCE_HOLD_WARMUP_DAYS;
      const low = rep != null && rep < EVIDENCE_HOLD_WARMUP_REPUTATION_THRESHOLD;
      if (!short && !low) {
        return "warmup is not under 21 days and reputation is not below threshold";
      }
      return null;
    }
  }
}

/**
 * THE hold gate. Every HOLD tag, mpd-0 hold, bounce-hold, and TERRL
 * hold request goes through here. Seats without their own evidence
 * are rejected and never held by pattern or by client.
 */
export function gateSeatHolds(
  seats: readonly SeatHoldRequest[],
  context: EvidenceHoldContext = {},
): EvidenceHoldGateResult {
  const now = context.now ?? new Date();
  const retired = hostSet(context.retiredDomains);
  const badSender = hostSet(context.badSenderDomains);
  const accepted: EvidenceHoldRecord[] = [];
  const rejected: RejectedHoldSeat[] = [];
  const seen = new Set<string>();

  for (const request of seats) {
    const decision = qualifySeat(request, now, retired, badSender);
    if ("rejectReason" in decision) {
      rejected.push(decision);
      continue;
    }
    if (seen.has(decision.email)) continue;
    seen.add(decision.email);
    accepted.push(decision);
  }

  return { accepted, rejected };
}

/** One #deliverability note. No em dashes. Lists every rejected seat. */
export function rejectedHoldSlackText(rejected: readonly RejectedHoldSeat[]): string | null {
  if (!rejected.length) return null;
  const lines = [
    `*Hold gate rejected ${rejected.length} seat${rejected.length === 1 ? "" : "s"} without their own evidence*`,
    "Review only. Nothing was held by pattern or by client.",
  ];
  for (const row of [...rejected].sort((a, b) => a.email.localeCompare(b.email))) {
    const email = row.email.trim() || "(unnamed)";
    lines.push(`• ${email}: ${row.rejectReason}`);
  }
  return lines.join("\n");
}

export interface EvidenceHoldWriter {
  upsertEvidenceHold(record: EvidenceHoldRecord): void;
  ensureBounceHold?(accountIds: Iterable<number>, now?: Date): void;
  ensureTenantTerlHold?(input: {
    tenant?: string;
    domains?: Iterable<string>;
    accountIds?: Iterable<number>;
    now?: Date;
  }): unknown;
  ensureTenantOutboundBlock?(input: {
    tenant?: string;
    domains?: Iterable<string>;
    accountIds?: Iterable<number>;
    now?: Date;
  }): unknown;
}

export function persistAcceptedHolds(
  store: EvidenceHoldWriter,
  accepted: readonly EvidenceHoldRecord[],
  now = new Date(),
): void {
  const bounceIds: number[] = [];
  const terlByTenant = new Map<string, number[]>();
  const outboundByTenant = new Map<string, number[]>();

  for (const record of accepted) {
    store.upsertEvidenceHold(record);
    const id = record.accountId;
    if (record.reason !== "hard_bounce_or_block" || id == null) continue;
    const smtp = extractSmtpCode(record.evidence.smtpCode) ?? "";
    bounceIds.push(id);
    const tenant = normalizeHost(record.evidence.tenant) || record.domain;
    if (smtp === "5.7.233") {
      const list = terlByTenant.get(tenant) ?? [];
      list.push(id);
      terlByTenant.set(tenant, list);
    }
    if (smtp === "5.1.8") {
      const list = outboundByTenant.get(tenant) ?? [];
      list.push(id);
      outboundByTenant.set(tenant, list);
    }
  }

  if (bounceIds.length) store.ensureBounceHold?.(bounceIds, now);
  for (const [tenant, accountIds] of terlByTenant) {
    store.ensureTenantTerlHold?.({
      tenant,
      domains: [tenant],
      accountIds,
      now,
    });
  }
  for (const [tenant, accountIds] of outboundByTenant) {
    store.ensureTenantOutboundBlock?.({
      tenant,
      domains: [tenant],
      accountIds,
      now,
    });
  }
}

export async function applyGuardedHoldRequest(input: {
  seats: readonly SeatHoldRequest[];
  store: EvidenceHoldWriter;
  slack?: { notifyDeliverabilityNote(text: string): Promise<unknown> };
  context?: EvidenceHoldContext;
}): Promise<EvidenceHoldGateResult> {
  const now = input.context?.now ?? new Date();
  const gated = gateSeatHolds(input.seats, { ...input.context, now });
  persistAcceptedHolds(input.store, gated.accepted, now);
  const text = rejectedHoldSlackText(gated.rejected);
  if (text && input.slack?.notifyDeliverabilityNote) {
    await input.slack.notifyDeliverabilityNote(text);
  }
  return gated;
}
