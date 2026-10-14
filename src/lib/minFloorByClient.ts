/**
 * D256 — per-client min-floor override. Unlisted clients stay at 40.
 * Default: TechEvo 521881 → 30. Env `MIN_FLOOR_BY_CLIENT` is
 * `clientId:floor` (comma-separated; `=` also accepted).
 */

import { TECHEVO_CLIENT_ID } from "./namedClientIds.js";

export const DEFAULT_MIN_FLOOR = 40;

export const DEFAULT_MIN_FLOOR_BY_CLIENT: Readonly<Record<number, number>> = {
  [TECHEVO_CLIENT_ID]: 30,
};

export function parseMinFloorByClient(
  raw: string | undefined,
  fallback: Readonly<Record<number, number>> = DEFAULT_MIN_FLOOR_BY_CLIENT,
): Record<number, number> {
  if (raw == null || raw.trim() === "") return { ...fallback };
  if (/^(none|off|-)$/i.test(raw.trim())) return {};
  const out: Record<number, number> = {};
  for (const part of raw.split(",")) {
    const [idRaw, floorRaw] = part.split(/[:=]/).map((s) => s.trim());
    const clientId = Number(idRaw);
    const floor = Number(floorRaw);
    if (!Number.isFinite(clientId) || clientId <= 0) continue;
    if (!Number.isFinite(floor) || floor < 1) continue;
    out[clientId] = Math.floor(floor);
  }
  return out;
}

export function minFloorForClient(
  clientId: number | null | undefined,
  byClient: Readonly<Record<number, number>> = DEFAULT_MIN_FLOOR_BY_CLIENT,
  fallback: number = DEFAULT_MIN_FLOOR,
): number {
  if (typeof clientId === "number" && Number.isFinite(clientId)) {
    const n = byClient[clientId];
    if (typeof n === "number" && Number.isFinite(n) && n >= 1) return n;
  }
  return fallback;
}
