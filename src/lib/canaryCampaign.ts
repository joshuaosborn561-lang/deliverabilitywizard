import { hashEmail } from "./restCohort.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A campaign is a canary while it is younger than `canaryDays` (default 7).
 * Missing / unparseable created_at ⇒ not a canary (full staffing).
 */
export function isCanaryCampaign(
  campaign: { created_at?: string | null },
  now: Date = new Date(),
  canaryDays = 7,
): boolean {
  const raw = campaign.created_at;
  if (!raw) return false;
  const created = Date.parse(raw);
  if (!Number.isFinite(created)) return false;
  return now.getTime() - created < canaryDays * MS_PER_DAY;
}

/**
 * ~15% of on-week client inboxes may attach to a canary campaign.
 * Generics are not filtered here — they remain the spare tire.
 */
export function canaryAllowsClientInbox(
  email: string,
  percent = 15,
): boolean {
  const cap = Math.min(100, Math.max(0, percent));
  return hashEmail(email) % 100 < cap;
}

/**
 * Pause the canary campaign (only) when this many unrelated sending
 * domains have dropped on same-ESP. Copy/offer problem, not one bad box.
 */
export function shouldPauseCanaryForDomainDrops(
  droppedUnrelatedDomains: number,
  minDomains = 3,
): boolean {
  return droppedUnrelatedDomains >= minDomains;
}

/** Unique sending domains whose same-ESP inbox is known-bad. */
export function droppedUnrelatedDomains(
  senders: Array<{
    domain: string;
    sameEspInbox: number | null | undefined;
    scoredSameEsp?: boolean;
  }>,
  threshold: number,
): string[] {
  const bad = new Set<string>();
  for (const sender of senders) {
    if (sender.scoredSameEsp !== true) continue;
    if (
      typeof sender.sameEspInbox === "number" &&
      sender.sameEspInbox < threshold
    ) {
      const domain = sender.domain.toLowerCase();
      if (domain) bad.add(domain);
    }
  }
  return [...bad];
}
