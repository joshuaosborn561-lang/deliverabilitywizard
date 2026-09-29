/**
 * D205 — standing always-allow for exclusive min-40 generic top-up.
 * Distinct from a leftover per-campaign D134 Slack tap (D193): this is
 * a per-client config Josh set once. Auto-allow clients get the fill
 * executed and do not get an Allow generics card.
 */

export const BCP_CLIENT_ID = 542838;
export const TECHEVO_CLIENT_ID = 521881;
export const PARLAY_CLIENT_ID = 418274;
export const INSIGHT_CLIENT_ID_FOR_ALLOW = 582890;
export const EMCOR_CLIENT_ID = 574020;
export const POWERGRYD_CLIENT_ID = 592842;

export const DEFAULT_AUTO_ALLOW_GENERIC_CLIENT_IDS: readonly number[] = [
  BCP_CLIENT_ID,
  TECHEVO_CLIENT_ID,
  PARLAY_CLIENT_ID,
  INSIGHT_CLIENT_ID_FOR_ALLOW,
  EMCOR_CLIENT_ID,
];

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

export function clientAutoAllowsGenerics(
  clientId: number | null | undefined,
  allowIds: readonly number[],
): boolean {
  return (
    typeof clientId === "number" &&
    Number.isFinite(clientId) &&
    allowIds.includes(clientId)
  );
}
