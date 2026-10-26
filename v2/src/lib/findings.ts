import type { Finding } from "../types.js";

/**
 * Which finding kinds a stage owns. Staff and isolation each replace only
 * their own kinds, so neither one reads and re-inserts the other's rows.
 */
export type FindingScope = { only: readonly string[] } | { except: readonly string[] };

export function inScope(kind: string, scope: FindingScope): boolean {
  return "only" in scope ? scope.only.includes(kind) : !scope.except.includes(kind);
}

export function findingKey(f: Finding): string {
  return [f.kind, f.campaignId ?? "", f.accountId ?? "", (f.email ?? "").toLowerCase(), f.detail].join("\u0001");
}

/**
 * One row per (kind, campaign, account, email, detail). The shadow test saw
 * ~293k duplicate_canary_test rows for ~a few hundred campaigns: concurrent
 * staff/isolation replaces both survived and re-inserted each other's rows.
 */
export function dedupeFindings(rows: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const row of rows) {
    const key = findingKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
