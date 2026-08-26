import { emailDomainOf } from "./isolationDomain.js";
import type { MailboxControlPlacement } from "./mailboxControlTag.js";

export const FLEET_MIN_FAILING_INBOXES = 3;
export const CLIENT_MIN_FAILING_INBOXES = 2;
export const RETIRE_AFTER_CONSECUTIVE_FAILS = 2;

export interface DomainMailboxReading {
  email: string;
  placement: MailboxControlPlacement;
  resting?: boolean;
}

export interface DomainCycleVerdict {
  domain: string;
  fleet: boolean;
  testedEmails: string[];
  failingEmails: string[];
  restingFailingEmails: string[];
  /** True when enough inboxes failed this cycle to count as a domain fail. */
  domainFailed: boolean;
  reason: string;
}

export interface DomainHistoryPoint {
  at: string;
  domainFailed: boolean;
  failingEmails: string[];
  testedEmails: string[];
}

/** True when Josh retired this sending domain — it must stay off live campaigns. */
export function isRetiredSendingDomain(
  domain: string | undefined,
  history: { status?: string } | undefined,
): boolean {
  if (!domain) return false;
  return history?.status === "retired";
}

export function isFleetDomain(
  domain: string,
  extraGenericDomains: string[],
): boolean {
  return extraGenericDomains.includes(domain.trim().toLowerCase());
}

export function minFailingInboxes(
  fleet: boolean,
  testedCount: number,
): number {
  if (testedCount <= 0) return Number.POSITIVE_INFINITY;
  if (fleet) return FLEET_MIN_FAILING_INBOXES;
  if (testedCount === 1) return 1;
  return Math.min(CLIENT_MIN_FAILING_INBOXES, testedCount);
}

export function judgeDomainCycle(
  domain: string,
  readings: DomainMailboxReading[],
  extraGenericDomains: string[],
): DomainCycleVerdict {
  const fleet = isFleetDomain(domain, extraGenericDomains);
  const tested = readings.filter((row) => row.placement !== "UNKNOWN");
  const failing = tested.filter((row) => row.placement === "SPAM");
  const restingFailing = failing.filter((row) => row.resting);
  const needed = minFailingInboxes(fleet, tested.length);
  const domainFailed = failing.length >= needed;
  let reason: string;
  if (!tested.length) {
    reason = "No known-good inbox-test reading for this domain yet.";
  } else if (domainFailed) {
    reason = fleet
      ? `${failing.length} inboxes on this fleet domain failed the known-good email (need at least ${needed}).`
      : `${failing.length} inbox${failing.length === 1 ? "" : "es"} on this domain failed the known-good email.`;
    if (restingFailing.length) {
      reason += ` ${restingFailing.length} of those are sitting off campaigns, so this is not “they’re just tired from sending.”`;
    }
  } else {
    reason = fleet
      ? `${failing.length} inbox${failing.length === 1 ? "" : "es"} failed — not enough to call the whole fleet dead (need ${needed} failing inboxes, not one).`
      : "Not enough inboxes failed the known-good email to condemn the domain.";
  }
  return {
    domain,
    fleet,
    testedEmails: tested.map((row) => row.email),
    failingEmails: failing.map((row) => row.email),
    restingFailingEmails: restingFailing.map((row) => row.email),
    domainFailed,
    reason,
  };
}

export function nextConsecutiveFails(
  previous: number,
  domainFailed: boolean,
): number {
  return domainFailed ? previous + 1 : 0;
}

export function groupReadingsByDomain(
  readings: DomainMailboxReading[],
): Map<string, DomainMailboxReading[]> {
  const out = new Map<string, DomainMailboxReading[]>();
  for (const row of readings) {
    const domain = emailDomainOf(row.email);
    if (!domain) continue;
    const list = out.get(domain) ?? [];
    list.push(row);
    out.set(domain, list);
  }
  return out;
}

export function buyAheadCount(
  domains: Array<{ consecutiveFails: number; status?: string }>,
): number {
  return domains.filter(
    (row) =>
      row.status !== "retired" &&
      row.consecutiveFails >= 1 &&
      row.consecutiveFails < RETIRE_AFTER_CONSECUTIVE_FAILS,
  ).length;
}
