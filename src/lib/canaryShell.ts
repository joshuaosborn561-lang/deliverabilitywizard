/** D114 — paused per-campaign shell that owns the unwarmed canary fleet. */

import { isPodControlShellCampaign } from "./podControlShell.js";

export const CANARY_SHELL_PREFIX = "Canary shell:";

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
