/**
 * D61 — Vasco keeps 40 inboxes (same mix, all send). GXA / MSRS / Nieto
 * inboxes are wiped from Smartlead and InboxKit.
 */

export const VASCO_KEEP_COUNT = 40;
export const DEFAULT_VASCO_PATTERNS = ["vasco"];
export const DEFAULT_WIPE_CLIENT_PATTERNS = ["gxa", "msrs", "nieto"];

export type EspBucket = "GOOGLE" | "MICROSOFT" | "OTHER";

export function nameHayMatches(
  hay: string,
  patterns: string[],
): boolean {
  const lower = hay.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    return Boolean(p) && lower.includes(p);
  });
}

export function pickKeepByMix<T>(
  rows: T[],
  keepCount: number,
  opts: {
    esp: (row: T) => EspBucket;
    prefer: (row: T) => boolean;
    key: (row: T) => string;
  },
): T[] {
  if (keepCount <= 0) return [];
  const sortedAll = [...rows].sort((a, b) =>
    opts.key(a).localeCompare(opts.key(b)),
  );
  if (sortedAll.length <= keepCount) return sortedAll;

  const groups = new Map<EspBucket, T[]>([
    ["GOOGLE", []],
    ["MICROSOFT", []],
    ["OTHER", []],
  ]);
  for (const row of rows) {
    groups.get(opts.esp(row))!.push(row);
  }

  const total = rows.length;
  const targets: Record<EspBucket, number> = {
    GOOGLE: Math.round((groups.get("GOOGLE")!.length / total) * keepCount),
    MICROSOFT: Math.round((groups.get("MICROSOFT")!.length / total) * keepCount),
    OTHER: 0,
  };
  targets.OTHER = keepCount - targets.GOOGLE - targets.MICROSOFT;
  for (const bucket of ["GOOGLE", "MICROSOFT", "OTHER"] as const) {
    targets[bucket] = Math.max(
      0,
      Math.min(targets[bucket], groups.get(bucket)!.length),
    );
  }

  let chosen = 0;
  const keep: T[] = [];
  const take = (bucket: EspBucket, n: number) => {
    const picked = takePreferred(
      groups.get(bucket)!,
      n,
      opts.prefer,
      opts.key,
    );
    keep.push(...picked);
    chosen += picked.length;
  };
  take("GOOGLE", targets.GOOGLE);
  take("MICROSOFT", targets.MICROSOFT);
  take("OTHER", targets.OTHER);

  if (chosen < keepCount) {
    const keptKeys = new Set(keep.map((row) => opts.key(row)));
    const leftover = takePreferred(
      rows.filter((row) => !keptKeys.has(opts.key(row))),
      keepCount - chosen,
      opts.prefer,
      opts.key,
    );
    keep.push(...leftover);
  }

  return keep.sort((a, b) => opts.key(a).localeCompare(opts.key(b)));
}

function takePreferred<T>(
  rows: T[],
  n: number,
  prefer: (row: T) => boolean,
  key: (row: T) => string,
): T[] {
  if (n <= 0) return [];
  return [...rows]
    .sort((a, b) => {
      const pref = Number(prefer(b)) - Number(prefer(a));
      if (pref) return pref;
      return key(a).localeCompare(key(b));
    })
    .slice(0, n);
}
