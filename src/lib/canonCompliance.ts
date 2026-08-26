import type { CampaignCheckRecord } from "./campaignCheck.js";

/**
 * D108 — the 15-minute yes/no. A living ACTIVE campaign is compliant
 * when none of these core holes are open. DNS / launch bar / client
 * tag sit on the board as "other" and do not flip the main yes.
 */
export const CANON_CORE_KINDS = [
  "understaffed",
  "under_warmed",
  "missing_signature_tag",
  "mailbox_sig",
  "mailbox_gap",
  "mailbox_volume",
  "no_placement_test",
  "missing_canary",
  "inbox_missing_known_good",
] as const;

export type CanonCoreKind = (typeof CANON_CORE_KINDS)[number];

export function findingKind(finding: string): string {
  return finding.split(":")[0] ?? "unknown";
}

export function campaignCanonYes(findings: string[]): boolean {
  return !findings.some((finding) =>
    (CANON_CORE_KINDS as readonly string[]).includes(findingKind(finding)),
  );
}

export interface CanonCampaignRow {
  campaignId: number;
  name: string;
  yes: boolean;
  fails: string[];
}

export function canonBoard(
  records: CampaignCheckRecord[],
): {
  compliant: boolean;
  campaigns: CanonCampaignRow[];
} {
  const campaigns = records.map((record) => {
    const fails = (record.findings ?? []).filter((finding) =>
      (CANON_CORE_KINDS as readonly string[]).includes(findingKind(finding)),
    );
    return {
      campaignId: record.campaignId,
      name: record.name,
      yes: fails.length === 0,
      fails: fails.map(findingKind),
    };
  });
  return {
    compliant: campaigns.every((row) => row.yes),
    campaigns,
  };
}
