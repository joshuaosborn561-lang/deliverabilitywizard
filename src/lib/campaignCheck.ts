/**
 * D81 / D82 — first-seen campaign audit, then hourly sweeps.
 *
 * First check is identity / safety. Hourly watches pods, signatures,
 * canaries, the on-week client-pod floor (D196), step-2 delay (D186), and merge-tag
 * fill (D180). Bounce auto-pause is not this checker (Cayden's D80).
 * Goliath is a POC client, not a special rule pile. Every serving
 * inbox needs a known-good canary; every campaign needs its copy on
 * the unwarmed fleet canary. Blank merge tags page Slack; they do
 * not START/STOP or rewrite live copy. Step-2 delay is written.
 */

export const CAMPAIGN_CHECK_KINDS = [
  "shell_not_paused",
  "missing_client_tag",
  "client_mismatch",
  "mailbox_sig",
  "insight_shared_staff",
  "insight_non_josh_sender",
  "missing_signature_tag",
  "foreign_brand_in_copy",
  "cross_client_membership",
  "missing_canary",
  "canary_inactive",
  "inbox_missing_known_good",
  "understaffed",
  "esp_mix",
  "no_placement_test",
  "under_warmed",
  "mailbox_gap",
  "mailbox_volume",
  "campaign_min_gap",
  "esp_matching_off",
  "campaign_send_gap",
  "send_window",
  "step2_delay",
  "missing_breakup_step",
  "below_launch_bar",
  "merge_tag_blank",
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
  "insight_shared_staff",
  "missing_signature_tag",
  "foreign_brand_in_copy",
  "cross_client_membership",
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
  /** D263 — last-seen Smartlead status so /health can count ACTIVE only. */
  status?: string | null;
  /** D95 — first auto-write already told Josh. Re-writes stay quiet. */
  sigAutoWrittenAt?: string | null;
  /** D180 — last merge-tag fill sample (lead total + custom tags seen). */
  mergeTagCheckedAt?: string | null;
  mergeTagLeadTotal?: number | null;
  mergeTagCustomKeys?: string[];
}

export function campaignCheckIsActive(
  record: Pick<CampaignCheckRecord, "campaignId" | "status">,
  statusById?: Map<number, string>,
): boolean {
  if (statusById?.has(record.campaignId)) {
    return String(statusById.get(record.campaignId) ?? "").toUpperCase() === "ACTIVE";
  }
  if (statusById && statusById.size > 0) {
    return false;
  }
  if (record.status != null && String(record.status) !== "") {
    return String(record.status).toUpperCase() === "ACTIVE";
  }
  return true;
}
