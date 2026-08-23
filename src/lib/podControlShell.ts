/** D56 — dedicated paused campaign whose sequence is the known-good email. */

export const POD_CONTROL_SHELL_NAME = "Pod control shell";

export function isPodControlShellCampaign(
  campaign: { id?: number | null; name?: string | null },
  pinnedId?: number,
): boolean {
  if (pinnedId && campaign.id === pinnedId) return true;
  const name = String(campaign.name ?? "").trim().toLowerCase();
  return (
    name === POD_CONTROL_SHELL_NAME.toLowerCase() ||
    name.startsWith("pod control shell")
  );
}

export function campaignIdFromCreate(raw: unknown): number | undefined {
  if (typeof raw === "number" && raw > 0) return raw;
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  for (const key of ["id", "campaign_id", "campaignId"]) {
    const n = Number(obj[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (obj.data && typeof obj.data === "object") {
    return campaignIdFromCreate(obj.data);
  }
  if (obj.campaign && typeof obj.campaign === "object") {
    return campaignIdFromCreate(obj.campaign);
  }
  return undefined;
}
