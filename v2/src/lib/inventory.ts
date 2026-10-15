export function dedupeById<T extends { id: number }>(rows: readonly T[]): T[] {
  const map = new Map<number, T>();
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    map.set(id, row);
  }
  return [...map.values()];
}
