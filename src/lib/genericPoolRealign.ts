import type { PoolMailboxRecord } from "../state/store.js";

/**
 * D257 — when live Smartlead `client_id` is a real named client and
 * the pool row still names a different client, rewrite the pool
 * assignment to match Smartlead. Does not clear a pool assignment
 * when the mailbox id is empty / leftover (D198).
 */
export function realignStalePoolAssignment(
  state: {
    getPoolMailbox: (email: string) => PoolMailboxRecord | undefined;
    upsertPoolMailbox?: (record: PoolMailboxRecord) => void;
  },
  email: string,
  liveClientId: number | null | undefined,
  now: Date = new Date(),
): boolean {
  if (typeof liveClientId !== "number" || !Number.isFinite(liveClientId)) {
    return false;
  }
  const key = email.trim().toLowerCase();
  const pool = state.getPoolMailbox(key);
  if (!pool) return false;
  if (typeof pool.assignedClientId !== "number") return false;
  if (pool.assignedClientId === liveClientId) return false;
  if (typeof state.upsertPoolMailbox !== "function") return false;
  state.upsertPoolMailbox({
    ...pool,
    assignedClientId: liveClientId,
    assignedAt: now.toISOString(),
  });
  return true;
}
