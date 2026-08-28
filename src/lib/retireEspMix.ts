/**
 * D150 — replacement mailbox ESP mix matches the retired domain's mix.
 * One platform per mailbox, same count as `perDomain` (or the retired
 * mailbox count when provided).
 */
import { poolEspFromSmartleadType } from "./poolSignature.js";

export type PoolPlatform = "GOOGLE" | "MICROSOFT";

export function espMixFromAccountTypes(
  types: Array<string | null | undefined>,
): { GOOGLE: number; MICROSOFT: number } {
  const counts = { GOOGLE: 0, MICROSOFT: 0 };
  for (const type of types) {
    const platform = poolEspFromSmartleadType(type);
    if (platform === "GOOGLE") counts.GOOGLE += 1;
    else if (platform === "MICROSOFT") counts.MICROSOFT += 1;
  }
  return counts;
}

/**
 * Build an ordered platform list of length `total` that mirrors `mix`.
 * Empty / unknown mix ⇒ alternate Google, Microsoft (legacy buy behaviour).
 */
export function platformsMatchingEspMix(
  mix: { GOOGLE: number; MICROSOFT: number },
  total: number,
): PoolPlatform[] {
  const n = Math.max(0, Math.floor(total));
  if (n === 0) return [];
  const known = mix.GOOGLE + mix.MICROSOFT;
  if (known <= 0) {
    return Array.from({ length: n }, (_, i) =>
      i % 2 === 0 ? "GOOGLE" : "MICROSOFT",
    );
  }
  const googleShare = mix.GOOGLE / known;
  let google = Math.round(googleShare * n);
  if (mix.GOOGLE > 0 && google === 0) google = 1;
  if (mix.MICROSOFT > 0 && google >= n) google = n - 1;
  google = Math.min(n, Math.max(0, google));
  const microsoft = n - google;
  const out: PoolPlatform[] = [
    ...Array.from({ length: google }, () => "GOOGLE" as const),
    ...Array.from({ length: microsoft }, () => "MICROSOFT" as const),
  ];
  return out;
}

export function platformsFromActionDetail(
  detail: Record<string, unknown>,
  perDomain: number,
): PoolPlatform[] | null {
  if (Array.isArray(detail.platforms)) {
    const parsed = detail.platforms
      .map((row) => String(row).toUpperCase())
      .filter((row): row is PoolPlatform => row === "GOOGLE" || row === "MICROSOFT");
    if (parsed.length) return parsed;
  }
  const mix = detail.espMix;
  if (mix && typeof mix === "object" && !Array.isArray(mix)) {
    const row = mix as { GOOGLE?: unknown; MICROSOFT?: unknown };
    return platformsMatchingEspMix(
      {
        GOOGLE: Number(row.GOOGLE ?? 0) || 0,
        MICROSOFT: Number(row.MICROSOFT ?? 0) || 0,
      },
      perDomain,
    );
  }
  return null;
}
