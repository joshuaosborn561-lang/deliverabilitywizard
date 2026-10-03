import { normalizeSenderEspFamily } from "./esp.js";
import { ON_WEEK_MIN_SENDERS, POD_INVENTORY_MIN_SENDERS } from "./clientStaffFloor.js";

/**
 * D221 — fleet-wide generic pool. One table, one row per generic seat.
 * A generic is assigned a client + POD only to bring that POD up to
 * 40 staffable senders. Surplus returns to the pool. No pre-split,
 * no idle hold, no separate generic rotation (POD rotation is it).
 */

export const GENERIC_POOL_POD_FLOOR = POD_INVENTORY_MIN_SENDERS;

/** Locked to the standing 40 (D197/D203/D207/D221). */
export const GENERIC_POOL_FLOOR_SOURCE = ON_WEEK_MIN_SENDERS;

export const GENERIC_POOL_POWERGRYD_CLIENT_ID = 592842;

export const GENERIC_ASSIGN_REASON_POD_TOP_UP = "pod_top_up";
export const GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE = "terrl_substitute";
/** PR (3) draft spelling — honour both so the 24h stop substitute is skipped. */
export const GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE_ALIAS = "terl_substitute";
export const GENERIC_ASSIGN_REASON_POWERGRYD = "powergryd_dedicated";

export const GENERIC_POOL_CORE_KINDS = [
  "generic_idle",
  "generic_multi_client",
] as const;

export type GenericPoolCoreKind = (typeof GENERIC_POOL_CORE_KINDS)[number];
export type GenericAssignedPod = "A" | "B";
export type GenericPoolProvider = "GOOGLE" | "MICROSOFT" | "OTHER";

export interface GenericSeatRecord {
  email: string;
  slAccountId: number | null;
  provider: GenericPoolProvider;
  warmReadyAt: string | null;
  assignedClientId: number | null;
  assignedCampaignIds: number[];
  assignedPod: GenericAssignedPod | null;
  assignedAt: string | null;
  reason: string | null;
}

export function isGenericPoolCoreKind(kind: string): kind is GenericPoolCoreKind {
  return (GENERIC_POOL_CORE_KINDS as readonly string[]).includes(kind);
}

export function genericSeatKey(email: string): string {
  return email.trim().toLowerCase();
}

export function clientPodKey(
  clientId: number,
  pod: GenericAssignedPod,
): string {
  return `${clientId}:${pod}`;
}

export function genericPoolNeedForPod(namedStaffableInPod: number): number {
  const named = Number.isFinite(namedStaffableInPod)
    ? Math.max(0, Math.floor(namedStaffableInPod))
    : 0;
  return Math.max(0, GENERIC_POOL_POD_FLOOR - named);
}

export function genericProviderFromAccountType(
  type: string | null | undefined,
): GenericPoolProvider {
  const family = normalizeSenderEspFamily(type);
  if (family === "google") return "GOOGLE";
  if (family === "microsoft") return "MICROSOFT";
  return "OTHER";
}

export function podFromMailboxTags(
  tags: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null | undefined,
): GenericAssignedPod | null {
  const names = (tags ?? []).map((tag) =>
    typeof tag === "string"
      ? tag.trim().toUpperCase()
      : String(tag.tag_name ?? tag.name ?? "").trim().toUpperCase(),
  );
  const hasA = names.some((name) => name === "POD-A" || name === "POD A");
  const hasB = names.some((name) => name === "POD-B" || name === "POD B");
  if (hasA && !hasB) return "A";
  if (hasB && !hasA) return "B";
  return null;
}

export function isTerrlSubstituteReason(
  reason: string | null | undefined,
): boolean {
  const value = String(reason ?? "").trim().toLowerCase();
  return (
    value === GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE ||
    value === GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE_ALIAS
  );
}

export function isPowerGrydDedicatedSeat(
  seat: Pick<GenericSeatRecord, "assignedClientId" | "reason">,
  powerGrydClientId: number = GENERIC_POOL_POWERGRYD_CLIENT_ID,
): boolean {
  if (seat.assignedClientId === powerGrydClientId) return true;
  return String(seat.reason ?? "").trim().toLowerCase() === GENERIC_ASSIGN_REASON_POWERGRYD;
}

export function genericPoolIdleExempt(
  seat: Pick<GenericSeatRecord, "assignedClientId" | "reason">,
  powerGrydClientId: number = GENERIC_POOL_POWERGRYD_CLIENT_ID,
): boolean {
  return isPowerGrydDedicatedSeat(seat, powerGrydClientId) || isTerrlSubstituteReason(seat.reason);
}

export function normalizeGenericSeat(raw: unknown): GenericSeatRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<GenericSeatRecord> & { sl_account_id?: unknown };
  const email = genericSeatKey(String(row.email ?? ""));
  if (!email.includes("@")) return null;
  const slAccountId = Number(row.slAccountId ?? row.sl_account_id ?? NaN);
  const providerRaw = String(row.provider ?? "OTHER").toUpperCase();
  const provider: GenericPoolProvider =
    providerRaw === "GOOGLE" || providerRaw === "MICROSOFT" ? providerRaw : "OTHER";
  const assignedClientId = Number(row.assignedClientId ?? NaN);
  const assignedPodRaw = String(row.assignedPod ?? "").toUpperCase();
  const assignedPod: GenericAssignedPod | null =
    assignedPodRaw === "A" || assignedPodRaw === "B" ? assignedPodRaw : null;
  const campaignIds = Array.isArray(row.assignedCampaignIds)
    ? row.assignedCampaignIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    : [];
  return {
    email,
    slAccountId: Number.isFinite(slAccountId) && slAccountId > 0 ? slAccountId : null,
    provider,
    warmReadyAt:
      typeof row.warmReadyAt === "string" && row.warmReadyAt.trim()
        ? row.warmReadyAt
        : null,
    assignedClientId:
      Number.isFinite(assignedClientId) && assignedClientId > 0
        ? assignedClientId
        : null,
    assignedCampaignIds: [...new Set(campaignIds)].sort((a, b) => a - b),
    assignedPod,
    assignedAt:
      typeof row.assignedAt === "string" && row.assignedAt.trim()
        ? row.assignedAt
        : null,
    reason:
      typeof row.reason === "string" && row.reason.trim() ? row.reason.trim() : null,
  };
}

export function emptyGenericSeat(
  email: string,
  extras: Partial<GenericSeatRecord> = {},
): GenericSeatRecord {
  return {
    email: genericSeatKey(email),
    slAccountId: extras.slAccountId ?? null,
    provider: extras.provider ?? "OTHER",
    warmReadyAt: extras.warmReadyAt ?? null,
    assignedClientId: extras.assignedClientId ?? null,
    assignedCampaignIds: extras.assignedCampaignIds ?? [],
    assignedPod: extras.assignedPod ?? null,
    assignedAt: extras.assignedAt ?? null,
    reason: extras.reason ?? null,
  };
}

export function clearGenericAssignment(
  seat: GenericSeatRecord,
): GenericSeatRecord {
  return {
    ...seat,
    assignedClientId: null,
    assignedCampaignIds: [],
    assignedPod: null,
    assignedAt: null,
    reason: null,
  };
}
