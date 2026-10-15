import { V2_INVENTORY_MAX_AGE_MS } from "../canon/constants.js";
import type { InventoryBook } from "../types.js";

export function dedupeById<T extends { id: number }>(rows: readonly T[]): T[] {
  const map = new Map<number, T>();
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    map.set(id, row);
  }
  return [...map.values()];
}

/** D278 — staff full inventory at most every 30 minutes. */
export function inventoryAgeMs(book: InventoryBook | null | undefined, now = Date.now()): number | null {
  if (!book?.fetchedAt) return null;
  const at = Date.parse(book.fetchedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

export function inventoryIsFresh(
  book: InventoryBook | null | undefined,
  now = Date.now(),
  maxAgeMs = V2_INVENTORY_MAX_AGE_MS,
): book is InventoryBook {
  const age = inventoryAgeMs(book, now);
  return age != null && age < maxAgeMs;
}

export async function loadOrRefreshInventory(
  store: { loadInventory(): Promise<InventoryBook | null> },
  fetchBook: () => Promise<InventoryBook>,
  now = Date.now(),
  maxAgeMs = V2_INVENTORY_MAX_AGE_MS,
): Promise<{ book: InventoryBook; refreshed: boolean; ageMs: number | null }> {
  const cached = await store.loadInventory();
  if (inventoryIsFresh(cached, now, maxAgeMs)) {
    return { book: cached, refreshed: false, ageMs: inventoryAgeMs(cached, now) };
  }
  const book = await fetchBook();
  return { book, refreshed: true, ageMs: 0 };
}
