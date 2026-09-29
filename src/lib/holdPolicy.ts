/**
 * D205 — standing campaign / client holds that the wizard must keep
 * PAUSED. Distinct from D40 (never auto-START a manual pause) and D148
 * (bounce loop never pauses). This is the only path that may write
 * PAUSED on a live client campaign, and only for the configured list.
 */

import { INSIGHT_SEG_CAMPAIGN_ID } from "./deliverabilitySlack.js";
import { isAnyShellCampaign } from "./canaryShell.js";

export const GOLIATH_CLIENT_ID = 548611;
export const GOLIATH_HOLD_UNTIL_YMD_DEFAULT = "2026-10-15";

/** Parlay SEGs, PE Thesis, Cold Call Followup, Insight SEG (known id). */
export const DEFAULT_HOLD_CAMPAIGN_IDS: readonly number[] = [
  3847837, 3847839, 3847844, 3847845, 3847846, 3847847, 3847849, 3847850,
  3969268, 3739316, INSIGHT_SEG_CAMPAIGN_ID,
];

/** Name fragments resolved at runtime (Insight SEG, SG Staffing CANDIDATES). */
export const DEFAULT_HOLD_CAMPAIGN_NAME_PATTERNS: readonly string[] = [
  "Insight SEG",
  "Staffing Owners CANDIDATES",
  "SG Staffing Owners CANDIDATES",
];

export interface HoldClientUntil {
  clientId: number;
  untilYmd: string;
}

export interface HoldPolicy {
  campaignIds: readonly number[];
  namePatterns: readonly string[];
  clientZeroActive: readonly HoldClientUntil[];
}

export const DEFAULT_HOLD_CLIENT_ZERO_ACTIVE: readonly HoldClientUntil[] = [
  { clientId: GOLIATH_CLIENT_ID, untilYmd: GOLIATH_HOLD_UNTIL_YMD_DEFAULT },
];

function isExplicitNone(raw: string): boolean {
  return /^(none|off|-)$/i.test(raw.trim());
}

export function parseIdList(raw: string | undefined, fallback: readonly number[]): number[] {
  if (raw == null || raw.trim() === "") return [...fallback];
  if (isExplicitNone(raw)) return [];
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed;
}

export function parseNamePatterns(
  raw: string | undefined,
  fallback: readonly string[],
): string[] {
  if (raw == null || raw.trim() === "") return [...fallback];
  if (isExplicitNone(raw)) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseClientUntilList(
  raw: string | undefined,
  fallback: readonly HoldClientUntil[],
): HoldClientUntil[] {
  if (raw == null || raw.trim() === "") return [...fallback];
  if (isExplicitNone(raw)) return [];
  const out: HoldClientUntil[] = [];
  for (const part of raw.split(",")) {
    const [idRaw, ymdRaw] = part.split(":").map((s) => s.trim());
    const clientId = Number(idRaw);
    const untilYmd = (ymdRaw ?? "").trim();
    if (!Number.isFinite(clientId) || clientId <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(untilYmd)) continue;
    out.push({ clientId, untilYmd });
  }
  return out;
}

export function ymdStillHeld(untilYmd: string, todayYmd: string): boolean {
  return todayYmd <= untilYmd;
}

function nameMatchesHoldPattern(name: string, pattern: string): boolean {
  const hay = name.toLowerCase();
  const tokens = pattern
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((token) => hay.includes(token));
}

export function campaignMatchesHoldName(
  name: string | null | undefined,
  patterns: readonly string[],
): boolean {
  const text = String(name ?? "").trim();
  if (!text || !patterns.length) return false;
  return patterns.some((pattern) => nameMatchesHoldPattern(text, pattern));
}

export function clientZeroActiveHold(
  clientId: number | null | undefined,
  policy: HoldPolicy,
  todayYmd: string,
): HoldClientUntil | undefined {
  if (typeof clientId !== "number" || !Number.isFinite(clientId)) return undefined;
  return policy.clientZeroActive.find(
    (row) => row.clientId === clientId && ymdStillHeld(row.untilYmd, todayYmd),
  );
}

/**
 * Why this campaign must stay PAUSED, or undefined if it is not held.
 * Shells are never a standing hold (they have their own PAUSED converge).
 */
export function campaignHoldReason(
  campaign: {
    id?: number | null;
    name?: string | null;
    client_id?: number | null;
  },
  policy: HoldPolicy,
  todayYmd: string,
): string | undefined {
  if (!campaign || isAnyShellCampaign(campaign)) return undefined;
  const id = typeof campaign.id === "number" ? campaign.id : 0;
  if (id > 0 && policy.campaignIds.includes(id)) {
    return `standing campaign hold #${id}`;
  }
  if (campaignMatchesHoldName(campaign.name, policy.namePatterns)) {
    return `standing name hold (${String(campaign.name)})`;
  }
  const clientHold = clientZeroActiveHold(campaign.client_id, policy, todayYmd);
  if (clientHold) {
    return `client ${clientHold.clientId} 0 ACTIVE until ${clientHold.untilYmd}`;
  }
  return undefined;
}

export function isHeldCampaign(
  campaign: {
    id?: number | null;
    name?: string | null;
    client_id?: number | null;
  },
  policy: HoldPolicy,
  todayYmd: string,
): boolean {
  return Boolean(campaignHoldReason(campaign, policy, todayYmd));
}

export function holdPolicyFromConfig(input: {
  holdCampaignIds: number[];
  holdCampaignNamePatterns: string[];
  holdClientZeroActive: HoldClientUntil[];
}): HoldPolicy {
  return {
    campaignIds: input.holdCampaignIds,
    namePatterns: input.holdCampaignNamePatterns,
    clientZeroActive: input.holdClientZeroActive,
  };
}
