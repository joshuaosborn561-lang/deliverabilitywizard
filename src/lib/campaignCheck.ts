/**
 * D81 / D82 — first-seen campaign audit, then hourly sweeps.
 *
 * First check is identity / safety. Hourly watches pods, signatures,
 * canaries, and the half-client floor. Bounce auto-pause is not this
 * checker (Cayden's D80). Goliath is a POC client, not a special rule
 * pile. Every serving inbox needs a known-good canary; every campaign
 * needs its copy on the unwarmed fleet canary.
 */

export const CAMPAIGN_CHECK_KINDS = [
  "shell_not_paused",
  "missing_client_tag",
  "client_mismatch",
  "mailbox_sig",
  "missing_signature_tag",
  "foreign_brand_in_copy",
  "cross_client_membership",
  "generic_unapproved",
  "missing_canary",
  "canary_inactive",
  "inbox_missing_known_good",
  "understaffed",
  "no_placement_test",
  "under_warmed",
  "mailbox_gap",
  "mailbox_volume",
  "campaign_min_gap",
  "below_launch_bar",
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
  "mailbox_sig",
  "missing_signature_tag",
  "foreign_brand_in_copy",
  "cross_client_membership",
  "generic_unapproved",
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
  /** D95 — first auto-write already told Josh. Re-writes stay quiet. */
  sigAutoWrittenAt?: string | null;
}
