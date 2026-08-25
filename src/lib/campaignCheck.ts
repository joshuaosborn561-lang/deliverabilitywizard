/**
 * D80 — first-seen campaign audit, then hourly sweeps.
 *
 * First check is the identity / safety pass. Hourly is the standing
 * watch (pod/shell, signatures, client tag, one-client, staffing).
 * Neither Slacks (D71). Neither STARTs a campaign, imports leads,
 * spends, or pulls a mailbox.
 */

export const CAMPAIGN_CHECK_KINDS = [
  "shell_not_paused",
  "missing_client_tag",
  "client_mismatch",
  "bounce_autopause",
  "mailbox_sig",
  "missing_signature_tag",
  "foreign_brand_in_copy",
  "cross_client_membership",
  "generic_on_non_goliath",
  "understaffed",
  "no_placement_test",
] as const;

export type CampaignCheckKind = (typeof CAMPAIGN_CHECK_KINDS)[number];

export interface CampaignFinding {
  kind: CampaignCheckKind;
  detail: string;
}

/** Findings that keep a campaign on the first-check loop. */
export const FIRST_CHECK_BLOCKING: ReadonlySet<CampaignCheckKind> = new Set([
  "shell_not_paused",
  "missing_client_tag",
  "client_mismatch",
  "bounce_autopause",
  "mailbox_sig",
  "missing_signature_tag",
  "foreign_brand_in_copy",
  "cross_client_membership",
  "generic_on_non_goliath",
]);

export function isFirstCheckBlocking(kind: CampaignCheckKind): boolean {
  return FIRST_CHECK_BLOCKING.has(kind);
}

export function firstCheckPassed(findings: CampaignFinding[]): boolean {
  return findings.every((finding) => !isFirstCheckBlocking(finding.kind));
}

export function formatFinding(finding: CampaignFinding): string {
  return `${finding.kind}: ${finding.detail}`;
}

export interface CampaignCheckRecord {
  campaignId: number;
  name: string;
  firstSeenAt: string;
  firstCheckAt: string | null;
  firstPassedAt: string | null;
  lastSweepAt: string | null;
  lastKind: "first" | "hourly";
  findings: string[];
}
