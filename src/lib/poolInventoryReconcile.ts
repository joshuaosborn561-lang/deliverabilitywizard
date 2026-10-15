/**
 * D252 — pool state can hold a seat Smartlead no longer lists.
 * Picking that ghost burns a campaign's 3-failure budget. Drop
 * available/assigned ghosts before pick. Warming / planned rows stay.
 * D269 — record gone emails so a freeze-kill sidecar can apply them
 * on load; a seat that reappears in inventory is forgotten.
 */

export interface GhostPoolSeat {
  email: string;
  status: string;
}

export interface PoolReconcileState {
  listPoolMailboxes: () => GhostPoolSeat[];
  removePoolMailbox: (email: string) => void;
  recordPoolGhost?: (email: string) => void;
  forgetPoolGhost?: (email: string) => void;
}

export function dropGhostPoolSeats(
  state: PoolReconcileState,
  inventoryEmails: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): string[] {
  const dropped: string[] = [];
  for (const row of state.listPoolMailboxes()) {
    const key = row.email.trim().toLowerCase();
    if (!key) continue;
    if (inventoryEmails.has(key)) {
      state.forgetPoolGhost?.(key);
      continue;
    }
    if (row.status !== "available" && row.status !== "assigned") continue;
    state.removePoolMailbox(key);
    state.recordPoolGhost?.(key);
    dropped.push(key);
  }
  return dropped;
}
