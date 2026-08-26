/** D114 — paused per-campaign shell that owns the unwarmed canary fleet. */

import { isPodControlShellCampaign } from "./podControlShell.js";

export const CANARY_SHELL_PREFIX = "Canary shell:";

/**
 * D118 — one dummy contact so SmartDelivery will schedule. Must not be a
 * Smartlead sending account (D117's fleet inbox was skipped). Shell stays
 * PAUSED. Not a client list (D52).
 */
export const CANARY_SHELL_SEED_EMAIL =
  "canary.instrumentation@getcrosslaunchco.info";

export function shellLeadImportAccepted(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const row = result as Record<string, unknown>;
  const counts = [
    row.added_count,
    row.upload_count,
    row.already_added_to_campaign,
    row.total_leads,
    row.total,
  ];
  if (counts.some((value) => Number(value) > 0)) return true;
  return Array.isArray(row.lead_ids) && row.lead_ids.length > 0;
}

export function shellLeadCount(listed: unknown): number {
  if (!listed || typeof listed !== "object") return 0;
  const row = listed as Record<string, unknown>;
  const nested =
    row.data && !Array.isArray(row.data) && typeof row.data === "object"
      ? (row.data as Record<string, unknown>)
      : null;
  const totals = [
    row.total_leads,
    row.total,
    row.totalLeads,
    nested?.total_leads,
    nested?.total,
    nested?.totalLeads,
  ];
  for (const value of totals) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const value of [row.data, row.leads, nested?.data, nested?.leads]) {
    if (Array.isArray(value) && value.length > 0) return value.length;
  }
  return 0;
}

export function canaryShellName(
  liveCampaignId: number,
  liveCampaignName?: string,
): string {
  const label = liveCampaignName?.trim()
    ? ` ${liveCampaignName.trim()}`
    : "";
  return `${CANARY_SHELL_PREFIX} #${liveCampaignId}${label}`.slice(0, 120);
}

export function isCanaryShellCampaign(campaign: {
  id?: number | null;
  name?: string | null;
}): boolean {
  const name = String(campaign.name ?? "").trim().toLowerCase();
  return name.startsWith("canary shell");
}

export function liveCampaignIdFromCanaryShellName(
  name: string | undefined,
): number | undefined {
  const match = String(name ?? "").match(/^canary shell:\s+#(\d+)/i);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : undefined;
}

export function isAnyShellCampaign(
  campaign: { id?: number | null; name?: string | null },
  pinnedPodControlId?: number,
): boolean {
  return (
    isCanaryShellCampaign(campaign) ||
    isPodControlShellCampaign(campaign, pinnedPodControlId)
  );
}
