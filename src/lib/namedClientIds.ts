/**
 * Standing Smartlead client ids used across staffing, floors, and
 * named-domain classification. These are identifiers, not an allow
 * list — D268 retired Allow-generics / auto-allow.
 */

export const BCP_CLIENT_ID = 542838;
export const TECHEVO_CLIENT_ID = 521881;
export const PARLAY_CLIENT_ID = 418274;
export const EMCOR_CLIENT_ID = 574020;
export const POWERGRYD_CLIENT_ID = 592842;
/** CornerStone Earthworks — held until 2026-12-31 (D283). */
export const CORNERSTONE_CLIENT_ID = 574088;
/** Roofs by Peterson — no restaff from the generics ledger (D286). */
export const PETERSON_CLIENT_ID = 548610;
/** Deep Roots Capital — POC / no restaff from the generics ledger (D286). */
export const DEEP_ROOTS_CLIENT_ID = 597783;

export function isPowerGrydClientId(id: number | null | undefined): boolean {
  return id === POWERGRYD_CLIENT_ID;
}

export function isCornerstoneClientId(id: number | null | undefined): boolean {
  return id === CORNERSTONE_CLIENT_ID;
}

export function parseClientIdList(
  raw: string | undefined,
  fallback: readonly number[],
): number[] {
  if (raw == null || raw.trim() === "") return [...fallback];
  if (/^(none|off|-)$/i.test(raw.trim())) return [];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}
