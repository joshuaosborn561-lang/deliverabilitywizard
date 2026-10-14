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
