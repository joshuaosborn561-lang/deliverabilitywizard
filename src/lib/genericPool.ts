import { normalizeSenderEspFamily } from "./esp.js";
import { ON_WEEK_MIN_SENDERS, POD_INVENTORY_MIN_SENDERS } from "./clientStaffFloor.js";

/**
 * D221 / D231 — fleet-wide generic pool. One table, one row per
 * generic seat. Every assign and release goes through this table.
 * D230 — one shared pool. A generic attaches to ONE client and ONE
 * POD and never rotates PODs. It returns to the untagged pool when
 * named seats fill that POD back to 40 (oldest / worst first).
 * Surplus beyond 40 also returns. Never pre-split across clients.
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
  "generic_outside_table",
] as const;

export const GENERIC_RELEASE_HISTORY_CAP = 50;

export type GenericPoolCoreKind = (typeof GENERIC_POOL_CORE_KINDS)[number];
export type GenericAssignedPod = "A" | "B";
export type GenericPoolProvider = "GOOGLE" | "MICROSOFT" | "OTHER";
export type AssignGenericError =
  | "missing_from_table"
  | "other_client"
  | "pod_rotate"
  | "invalid";

export interface GenericReleaseEvent {
  releasedAt: string;
  clientId: number | null;
  pod: GenericAssignedPod | null;
  reason: string | null;
}

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
  releasedAt: string | null;
  releaseHistory: GenericReleaseEvent[];
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
  const releasedAtRaw = (row as { released_at?: unknown }).released_at ?? row.releasedAt;
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
    releasedAt:
      typeof releasedAtRaw === "string" && releasedAtRaw.trim()
        ? releasedAtRaw
        : null,
    releaseHistory: normalizeReleaseHistory(
      (row as { release_history?: unknown }).release_history ?? row.releaseHistory,
    ),
  };
}

function normalizeReleaseHistory(raw: unknown): GenericReleaseEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: GenericReleaseEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<GenericReleaseEvent> & { released_at?: unknown };
    const releasedAt =
      typeof row.releasedAt === "string" && row.releasedAt.trim()
        ? row.releasedAt
        : typeof row.released_at === "string" && row.released_at.trim()
          ? row.released_at
          : null;
    if (!releasedAt) continue;
    const clientId = Number(row.clientId ?? NaN);
    const podRaw = String(row.pod ?? "").toUpperCase();
    out.push({
      releasedAt,
      clientId: Number.isFinite(clientId) && clientId > 0 ? clientId : null,
      pod: podRaw === "A" || podRaw === "B" ? podRaw : null,
      reason:
        typeof row.reason === "string" && row.reason.trim()
          ? row.reason.trim()
          : null,
    });
  }
  return out.slice(-GENERIC_RELEASE_HISTORY_CAP);
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
    releasedAt: extras.releasedAt ?? null,
    releaseHistory: extras.releaseHistory ?? [],
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

export interface AssignGenericSeatInput {
  email: string;
  clientId: number;
  pod?: GenericAssignedPod | null;
  reason: string;
  campaignIds?: number[];
  slAccountId?: number | null;
  now?: Date;
}

export type AssignGenericSeatResult =
  | { ok: true; seat: GenericSeatRecord }
  | { ok: false; error: AssignGenericError };

export function applyAssignGenericSeat(
  existing: GenericSeatRecord | undefined,
  input: AssignGenericSeatInput,
): AssignGenericSeatResult {
  if (!existing) return { ok: false, error: "missing_from_table" };
  const clientId = Number(input.clientId);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return { ok: false, error: "invalid" };
  }
  if (
    existing.assignedClientId != null &&
    existing.assignedClientId !== clientId
  ) {
    return { ok: false, error: "other_client" };
  }
  const nextPod = input.pod ?? existing.assignedPod ?? null;
  if (
    existing.assignedPod != null &&
    nextPod != null &&
    existing.assignedPod !== nextPod
  ) {
    return { ok: false, error: "pod_rotate" };
  }
  const nowIso = (input.now ?? new Date()).toISOString();
  const campaignIds = [
    ...new Set([
      ...existing.assignedCampaignIds,
      ...(input.campaignIds ?? []).map((id) => Number(id)),
    ]),
  ]
    .filter((id) => Number.isFinite(id) && id > 0)
    .sort((a, b) => a - b);
  return {
    ok: true,
    seat: {
      ...existing,
      slAccountId: input.slAccountId ?? existing.slAccountId,
      assignedClientId: clientId,
      assignedCampaignIds: campaignIds,
      assignedPod: nextPod,
      assignedAt: existing.assignedAt ?? nowIso,
      reason: existing.reason ?? input.reason,
    },
  };
}

export function applyReleaseGenericSeat(
  existing: GenericSeatRecord,
  opts: { now?: Date; reason?: string | null } = {},
): GenericSeatRecord {
  if (existing.assignedClientId == null && existing.assignedPod == null) {
    return {
      ...existing,
      assignedCampaignIds: [],
      assignedAt: null,
      reason: null,
    };
  }
  const releasedAt = (opts.now ?? new Date()).toISOString();
  const event: GenericReleaseEvent = {
    releasedAt,
    clientId: existing.assignedClientId,
    pod: existing.assignedPod,
    reason: opts.reason ?? existing.reason,
  };
  return {
    ...existing,
    assignedClientId: null,
    assignedCampaignIds: [],
    assignedPod: null,
    assignedAt: null,
    reason: null,
    releasedAt,
    releaseHistory: [...existing.releaseHistory, event].slice(
      -GENERIC_RELEASE_HISTORY_CAP,
    ),
  };
}

export function mergeSeededGenericSeat(
  existing: GenericSeatRecord | undefined,
  next: GenericSeatRecord,
  now: Date = new Date(),
): GenericSeatRecord {
  const history = existing?.releaseHistory ?? [];
  const releasedAt = existing?.releasedAt ?? null;
  if (existing?.assignedClientId != null && next.assignedClientId == null) {
    const event: GenericReleaseEvent = {
      releasedAt: now.toISOString(),
      clientId: existing.assignedClientId,
      pod: existing.assignedPod,
      reason: existing.reason ?? "seed_sync",
    };
    return {
      ...next,
      releasedAt: event.releasedAt,
      releaseHistory: [...history, event].slice(-GENERIC_RELEASE_HISTORY_CAP),
    };
  }
  return {
    ...next,
    releasedAt,
    releaseHistory: history,
  };
}
