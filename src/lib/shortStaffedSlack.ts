/**
 * D248 — short-staffed log lines only on change, one line per client.
 */

export interface ShortStaffedRow {
  clientKey: string;
  clientName: string;
  shortBy: number;
  campaigns: number;
}

export function groupShortStaffedByClient(
  rows: Array<{
    clientId?: number | string;
    clientName?: string;
    name: string;
    shortBy: number;
  }>,
): ShortStaffedRow[] {
  const byKey = new Map<string, ShortStaffedRow>();
  for (const row of rows) {
    const clientName = (row.clientName ?? row.name).trim() || row.name;
    const clientKey =
      row.clientId != null && String(row.clientId).trim()
        ? `id:${row.clientId}`
        : `name:${clientName.toLowerCase()}`;
    const existing = byKey.get(clientKey);
    if (existing) {
      existing.shortBy += row.shortBy;
      existing.campaigns += 1;
      continue;
    }
    byKey.set(clientKey, {
      clientKey,
      clientName,
      shortBy: row.shortBy,
      campaigns: 1,
    });
  }
  return [...byKey.values()].sort((a, b) =>
    a.clientName.localeCompare(b.clientName),
  );
}

export function shortStaffedSnapshot(rows: ShortStaffedRow[]): string {
  return rows
    .map((row) => `${row.clientKey}:${row.shortBy}:${row.campaigns}`)
    .join("|");
}

export function shortStaffedLines(rows: ShortStaffedRow[]): string | null {
  if (!rows.length) return null;
  return rows
    .map(
      (row) =>
        `${row.clientName} is short ${row.shortBy} staffable across ${row.campaigns} campaign${row.campaigns === 1 ? "" : "s"}.`,
    )
    .join("\n");
}
