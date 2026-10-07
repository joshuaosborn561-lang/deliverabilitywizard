/**
 * D222 / D226 — InboxKit lapsed-license sweep. Compare InboxKit
 * mailbox status to Smartlead connected accounts. Findings go to
 * Onboarding and Deliverability through state / /health (not Slack).
 * Lapsed seats are deleted from Smartlead and InboxKit. The only
 * Slack post is the post-cleanup one-liner when X > 0.
 *
 * D245 — the real InboxKit mailbox row has no `email`; it carries
 * `username` + `domain_name`. A seat whose cancel date has been reached
 * (scheduled_for_cancellation with renewal_date on or before today CT)
 * is lapsed whether or not Smartlead still logs in. An `active` row with
 * a stale past renewal_date is NOT lapsed (InboxKit renews at domain
 * level and does not advance the mailbox field). Runs every weekday.
 */

import { chicagoWallClock } from "./canonOpsHours.js";

export const INBOXKIT_LICENSE_SLACK_CHANNEL_ID = "C0BJQUTV7A8";
export const LAPSED_INBOXKIT_STATUSES = [
  "lapsed",
  "cancelled",
  "canceled",
  "inactive",
  "renewal_failed",
  "suspended",
  "deleted",
  "archived",
] as const;

export const SCHEDULED_CANCEL_STATUSES = [
  "scheduled_for_cancellation",
  "scheduled_cancellation",
  "pending_cancellation",
] as const;

export interface InboxkitLicenseMailbox {
  email?: string;
  address?: string;
  username?: string;
  domain_name?: string;
  domain?: string;
  uid?: string;
  id?: string;
  workspaceId?: string;
  status?: string;
  license_status?: string;
  renewal_date?: string | null;
  cancel_date?: string | null;
  cancellation_date?: string | null;
  scheduled_cancellation_date?: string | null;
  cancelled_at?: string | null;
  canceled_at?: string | null;
  cancellation_scheduled_at?: string | null;
  cancel_at?: string | null;
}

export interface InboxkitLicenseSlAccount {
  id?: number;
  from_email?: string;
  email?: string;
  username?: string;
  client_id?: number | null;
  is_smtp_success?: boolean;
  is_imap_success?: boolean;
}

export type InboxkitLicenseKind = "still_connected" | "scheduled_cancel";
export type InboxkitLicenseSkip = "not_connected" | "healthy";

export interface InboxkitLicenseFinding {
  kind: InboxkitLicenseKind;
  email: string;
  clientId: number | null;
  clientName: string;
  inboxkitStatus: string;
  cancelDate: string | null;
  slAccountId: number | null;
  inboxkitUid: string | null;
  workspaceId: string | null;
}

export interface InboxkitLicenseHandoffSeat {
  email: string;
  inboxkitStatus: string;
  cancelDate: string | null;
  slAccountId: number | null;
}

export interface InboxkitLicenseHandoffClient {
  clientId: number | null;
  clientName: string;
  stillConnected: InboxkitLicenseHandoffSeat[];
  upcomingCancellations: InboxkitLicenseHandoffSeat[];
}

export interface InboxkitLicenseHandoff {
  at: string;
  ymd: string;
  deleted: number;
  deletedEmails: string[];
  clients: InboxkitLicenseHandoffClient[];
}

export function inboxkitMailboxEmail(mailbox: InboxkitLicenseMailbox): string {
  const direct = String(mailbox.email || mailbox.address || "")
    .trim()
    .toLowerCase();
  if (direct.includes("@")) return direct;
  // D245: InboxKit /v1/api/mailboxes/list rows carry username + domain_name.
  const user = String(mailbox.username || "").trim().toLowerCase();
  const domain = String(mailbox.domain_name || mailbox.domain || "")
    .trim()
    .toLowerCase();
  if (user && domain) return user.includes("@") ? user : `${user}@${domain}`;
  return direct;
}

export function inboxkitStatusOf(mailbox: InboxkitLicenseMailbox): string {
  return String(mailbox.status || mailbox.license_status || "")
    .trim()
    .toLowerCase();
}

export function isLapsedInboxkitStatus(status: string): boolean {
  const value = status.trim().toLowerCase();
  return (LAPSED_INBOXKIT_STATUSES as readonly string[]).includes(value);
}

export function isScheduledCancelStatus(status: string): boolean {
  const value = status.trim().toLowerCase();
  return (SCHEDULED_CANCEL_STATUSES as readonly string[]).includes(value);
}

const CANCEL_DATE_KEYS = [
  "cancel_date",
  "cancellation_date",
  "scheduled_cancellation_date",
  "cancelled_at",
  "canceled_at",
  "cancellation_scheduled_at",
  "cancel_at",
] as const;

export function parseInboxkitDate(raw: unknown): Date | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const iso = text.includes("T") ? text : `${text}T00:00:00Z`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed);
}

export function cancelDateOf(
  mailbox: InboxkitLicenseMailbox,
): { date: Date | null; raw: string | null } {
  const rec = mailbox as Record<string, unknown>;
  const keys: string[] = [...CANCEL_DATE_KEYS];
  if (isScheduledCancelStatus(inboxkitStatusOf(mailbox))) {
    keys.push("renewal_date");
  }
  for (const key of keys) {
    const raw = rec[key];
    if (raw == null || String(raw).trim() === "") continue;
    return { date: parseInboxkitDate(raw), raw: String(raw).trim() };
  }
  return { date: null, raw: null };
}

export function chicagoYmd(now: Date = new Date()): string {
  return chicagoWallClock(now).ymd;
}

export function dateYmd(
  date: Date,
  timeZone = "America/Chicago",
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const num = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const year = num("year");
  const month = num("month");
  const day = num("day");
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * D245 — the cancel date has been reached: on or before today in
 * America/Chicago. Delete on the cancel day, not the day after.
 */
export function isPastCancelDate(
  mailbox: InboxkitLicenseMailbox,
  now: Date = new Date(),
): boolean {
  const { date } = cancelDateOf(mailbox);
  if (!date) return false;
  return dateYmd(date) <= chicagoYmd(now);
}

/** D245 — cancel date (or lapsed status) within `days` of now. */
export function isInboxkitEndingWithin(
  mailbox: InboxkitLicenseMailbox,
  days: number,
  now: Date = new Date(),
): boolean {
  const status = inboxkitStatusOf(mailbox);
  if (isLapsedInboxkitStatus(status)) return true;
  if (!isScheduledCancelStatus(status)) return false;
  const { date } = cancelDateOf(mailbox);
  if (!date) return false;
  return date.getTime() <= now.getTime() + days * 24 * 60 * 60 * 1000;
}

/** D245 — daily on weekdays (America/Chicago); weekends idle. */
export function inboxkitLicenseIdleReason(
  now: Date = new Date(),
): string | undefined {
  const clock = chicagoWallClock(now);
  if (clock.weekday === 0 || clock.weekday === 6) {
    return "weekend (InboxKit license sweep is weekdays only)";
  }
  return undefined;
}

export function classifyInboxkitLicenseSeat(input: {
  mailbox: InboxkitLicenseMailbox;
  account?: InboxkitLicenseSlAccount | null;
  clientName?: string;
  now?: Date;
}): { skip: InboxkitLicenseSkip } | { finding: InboxkitLicenseFinding } {
  const now = input.now ?? new Date();
  const email = inboxkitMailboxEmail(input.mailbox);
  const status = inboxkitStatusOf(input.mailbox);
  const account = input.account ?? null;
  // D245: any Smartlead account counts. A lapsed seat that already lost
  // SMTP/IMAP is still linked to campaigns and must be removed too.
  if (!email || !account) return { skip: "not_connected" };
  const { raw: cancelRaw } = cancelDateOf(input.mailbox);
  const clientId =
    typeof account?.client_id === "number" && account.client_id > 0
      ? account.client_id
      : null;
  const slAccountId =
    typeof account?.id === "number" && account.id > 0 ? account.id : null;
  const inboxkitUid = String(input.mailbox.uid || input.mailbox.id || "").trim() || null;
  const workspaceId = String(input.mailbox.workspaceId || "").trim() || null;
  const base = {
    email,
    clientId,
    clientName: input.clientName?.trim() || (clientId ? `Client ${clientId}` : "Unassigned"),
    inboxkitStatus: status || "unknown",
    cancelDate: cancelRaw,
    slAccountId,
    inboxkitUid,
    workspaceId,
  };
  if (isPastCancelDate(input.mailbox, now) || isLapsedInboxkitStatus(status)) {
    return { finding: { kind: "still_connected", ...base } };
  }
  if (isScheduledCancelStatus(status) || cancelRaw) {
    return { finding: { kind: "scheduled_cancel", ...base } };
  }
  return { skip: "healthy" };
}

export function classifyInboxkitLicenseSweep(input: {
  mailboxes: InboxkitLicenseMailbox[];
  accounts: InboxkitLicenseSlAccount[];
  clientNameById?: ReadonlyMap<number, string>;
  now?: Date;
}): InboxkitLicenseFinding[] {
  const now = input.now ?? new Date();
  const byEmail = new Map<string, InboxkitLicenseSlAccount>();
  for (const account of input.accounts) {
    const email = String(
      account.from_email || account.email || account.username || "",
    )
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) continue;
    if (!byEmail.has(email)) byEmail.set(email, account);
  }
  // D245: an address re-bought in another workspace (any live row that is
  // neither lapsed nor scheduled to cancel) is healthy; never delete it.
  const live = new Set<string>();
  for (const mailbox of input.mailboxes) {
    const status = inboxkitStatusOf(mailbox);
    if (!isLapsedInboxkitStatus(status) && !isScheduledCancelStatus(status)) {
      const email = inboxkitMailboxEmail(mailbox);
      if (email) live.add(email);
    }
  }
  const out: InboxkitLicenseFinding[] = [];
  const seen = new Set<string>();
  for (const mailbox of input.mailboxes) {
    const email = inboxkitMailboxEmail(mailbox);
    if (!email || seen.has(email) || live.has(email)) continue;
    const account = byEmail.get(email);
    const clientId =
      typeof account?.client_id === "number" ? account.client_id : null;
    const classified = classifyInboxkitLicenseSeat({
      mailbox,
      account,
      clientName: clientId != null ? input.clientNameById?.get(clientId) : undefined,
      now,
    });
    if (!("finding" in classified)) continue;
    seen.add(email);
    out.push(classified.finding);
  }
  return out.sort((a, b) => {
    const client = a.clientName.localeCompare(b.clientName);
    if (client !== 0) return client;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.email.localeCompare(b.email);
  });
}

export function groupInboxkitLicenseHandoff(
  findings: InboxkitLicenseFinding[],
): InboxkitLicenseHandoffClient[] {
  const byClient = new Map<string, InboxkitLicenseHandoffClient>();
  for (const finding of findings) {
    const key = `${finding.clientName}::${finding.clientId ?? "none"}`;
    const group = byClient.get(key) ?? {
      clientId: finding.clientId,
      clientName: finding.clientName,
      stillConnected: [],
      upcomingCancellations: [],
    };
    const seat: InboxkitLicenseHandoffSeat = {
      email: finding.email,
      inboxkitStatus: finding.inboxkitStatus,
      cancelDate: finding.cancelDate,
      slAccountId: finding.slAccountId,
    };
    if (finding.kind === "scheduled_cancel") {
      group.upcomingCancellations.push(seat);
    } else {
      group.stillConnected.push(seat);
    }
    byClient.set(key, group);
  }
  return [...byClient.values()];
}

export function formatInboxkitLicenseCleanupSlack(deleted: number): string | null {
  if (!Number.isFinite(deleted) || deleted <= 0) return null;
  return `Found ${deleted} inboxes that had lapsed; they're deleted from Smartlead and InboxKit.`;
}

export function parseInboxkitLicenseHandoff(
  raw: unknown,
): InboxkitLicenseHandoff | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<InboxkitLicenseHandoff>;
  if (typeof row.at !== "string" || typeof row.ymd !== "string") return null;
  return {
    at: row.at,
    ymd: row.ymd,
    deleted: Number.isFinite(row.deleted) ? Number(row.deleted) : 0,
    deletedEmails: Array.isArray(row.deletedEmails)
      ? row.deletedEmails.map((email) => String(email).toLowerCase())
      : [],
    clients: Array.isArray(row.clients)
      ? row.clients.map((client) => ({
          clientId:
            typeof client.clientId === "number" ? client.clientId : null,
          clientName: String(client.clientName ?? "Unassigned"),
          stillConnected: Array.isArray(client.stillConnected)
            ? client.stillConnected
            : [],
          upcomingCancellations: Array.isArray(client.upcomingCancellations)
            ? client.upcomingCancellations
            : [],
        }))
      : [],
  };
}

/** D245 — per-seat InboxKit end date, persisted for staffing eligibility. */
export interface InboxkitSeatEnd {
  status: string;
  cancelDate: string | null;
}

/**
 * D245 — every InboxKit address that is lapsed or scheduled to cancel
 * (and has no live row elsewhere), keyed by lowercase email.
 */
export function buildInboxkitSeatEnds(
  mailboxes: InboxkitLicenseMailbox[],
): Record<string, InboxkitSeatEnd> {
  const live = new Set<string>();
  const out: Record<string, InboxkitSeatEnd> = {};
  for (const mailbox of mailboxes) {
    const email = inboxkitMailboxEmail(mailbox);
    if (!email) continue;
    const status = inboxkitStatusOf(mailbox);
    if (!isLapsedInboxkitStatus(status) && !isScheduledCancelStatus(status)) {
      live.add(email);
      continue;
    }
    if (out[email]) continue;
    out[email] = { status, cancelDate: cancelDateOf(mailbox).raw };
  }
  for (const email of live) delete out[email];
  return out;
}

export function parseInboxkitSeatEnds(raw: unknown): Record<string, InboxkitSeatEnd> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, InboxkitSeatEnd> = {};
  for (const [email, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Partial<InboxkitSeatEnd>;
    out[email.toLowerCase()] = {
      status: String(row.status ?? ""),
      cancelDate: typeof row.cancelDate === "string" ? row.cancelDate : null,
    };
  }
  return out;
}

/** D245 — staffing gate: lapsed, or cancel date within `days` (default 7). */
export function seatEndBlocksStaffing(
  end: InboxkitSeatEnd | undefined,
  now: Date = new Date(),
  days = 7,
): boolean {
  if (!end) return false;
  return isInboxkitEndingWithin(
    { status: end.status, renewal_date: end.cancelDate },
    days,
    now,
  );
}

/** D245 — lapsed now: lapsed status or cancel date reached (CT day). */
export function seatEndIsLapsed(
  end: InboxkitSeatEnd | undefined,
  now: Date = new Date(),
): boolean {
  if (!end) return false;
  if (isLapsedInboxkitStatus(end.status)) return true;
  return isPastCancelDate({ status: end.status, renewal_date: end.cancelDate }, now);
}
