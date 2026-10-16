import { minFloorForClient } from "../canon/constants.js";
import type { Finding, SlimAccount, SlimCampaign } from "../types.js";
import {
  emailDomain,
  hasTag,
  isActiveStatus,
  isStaffableSender,
  mailboxWeight,
  podOf,
} from "./staffable.js";

export function isGenericSeat(
  account: SlimAccount,
  extraGenericDomains: readonly string[] = [],
): boolean {
  if (hasTag(account.tags, "GENERIC")) return true;
  const domain = emailDomain(account.email);
  return extraGenericDomains.some((d) => d === domain);
}

/**
 * D221 — a GENERIC assigned to a campaign whose named on-week staffable
 * already meets the floor is idle (not needed to reach 40 / TechEvo 30).
 */
export function genericIdleFindings(opts: {
  campaign: SlimCampaign;
  accounts: readonly SlimAccount[];
  floor?: number;
  week: "A" | "B";
  fleetEmails?: readonly string[];
  extraGenericDomains?: readonly string[];
  now?: number;
}): Finding[] {
  if (!isActiveStatus(opts.campaign.status)) return [];
  const floor = opts.floor ?? minFloorForClient(opts.campaign.clientId);
  const members = opts.accounts.filter((a) => a.campaignIds.includes(opts.campaign.id));
  const onWeekStaffable = (account: SlimAccount): boolean =>
    isStaffableSender(account, {
      fleetEmails: opts.fleetEmails,
      now: opts.now,
      requireOnWeekPod: true,
      onWeek: opts.week,
    });
  const extras = opts.extraGenericDomains ?? [];
  const namedWeight = members
    .filter((a) => onWeekStaffable(a) && !isGenericSeat(a, extras))
    .reduce((sum, a) => sum + mailboxWeight(a), 0);
  let remainingNeed = Math.max(0, floor - namedWeight);
  const findings: Finding[] = [];
  const generics = members.filter(
    (a) => isGenericSeat(a, extras) && onWeekStaffable(a) && podOf(a) === opts.week,
  );
  for (const account of generics) {
    const weight = mailboxWeight(account);
    if (remainingNeed > 1e-6) {
      remainingNeed -= weight;
      continue;
    }
    findings.push({
      kind: "generic_idle",
      campaignId: opts.campaign.id,
      accountId: account.id,
      email: account.email,
      detail: `${account.email} assigned to #${opts.campaign.id} POD ${opts.week} but named staffable already meets floor ${floor}`,
    });
  }
  return findings;
}
