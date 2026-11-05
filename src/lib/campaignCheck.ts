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
  "client_seat_crossover",
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
  "below_launch_bar",
  "merge_tag_blank",
  "unverified",
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
  "client_seat_crossover",
]);

export function isFirstCheckBlocking(kind: CampaignCheckKind): boolean {
  return FIRST_CHECK_BLOCKING.has(kind);
}

export function firstCheckPassed(findings: CampaignFinding[]): boolean {
  return findings.every((finding) => !isFirstCheckBlocking(finding.kind));
}

/**
 * Findings that come from reading the campaign's sequences. When the
 * sequence read fails (Smartlead 429, timeout, 5xx) the pass cannot judge
 * them, so the last stored ones are carried forward instead of silently
 * dropping to "clean".
 */
export const SEQUENCE_DERIVED_KINDS: ReadonlySet<string> = new Set([
  "step2_delay",
  "missing_signature_tag",
  "foreign_brand_in_copy",
  "merge_tag_blank",
]);

/** Parse stored `kind: detail` strings back into findings of the given kinds. */
export function carryStoredFindings(
  stored: string[] | null | undefined,
  kinds: ReadonlySet<string>,
): CampaignFinding[] {
  const out: CampaignFinding[] = [];
  for (const row of stored ?? []) {
    const idx = row.indexOf(":");
    const kind = (idx >= 0 ? row.slice(0, idx) : row).trim();
    if (!kinds.has(kind)) continue;
    out.push({
      kind: kind as CampaignCheckKind,
      detail: idx >= 0 ? row.slice(idx + 1).trim() : "",
    });
  }
  return out;
}

/**
 * A pass whose Smartlead reads failed is unverified, never clean.
 * Keeps the prior sequence findings and adds one `unverified` finding.
 */
export function unverifiedFindings(input: {
  error: string;
  current: CampaignFinding[];
  priorStored: string[] | null | undefined;
}): CampaignFinding[] {
  const out = [...input.current];
  const seen = new Set(out.map((row) => `${row.kind}:${row.detail}`));
  for (const row of carryStoredFindings(input.priorStored, SEQUENCE_DERIVED_KINDS)) {
    const key = `${row.kind}:${row.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  out.push({
    kind: "unverified",
    detail: `sequences not read (${input.error}); last sequence findings carried, retry next pass`,
  });
  return out;
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
