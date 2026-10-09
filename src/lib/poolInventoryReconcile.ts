/**
 * D251 — pool state can hold a seat Smartlead no longer lists.
 * Picking that ghost burns a campaign's 3-failure budget and never
 * tries a real candidate. Drop available/assigned ghosts before pick.
 * Planned / warming / provisioning rows stay (they are not inventory yet).
 */

export interface GhostPoolSeat {
  email: string;
  domain: string;
  platform: "GOOGLE" | "MICROSOFT";
  status: string;
  smartleadAccountId?: number;
}

export interface PoolReconcileState {
  listPoolMailboxes: () => GhostPoolSeat[];
  removePoolMailbox: (email: string) => void;
}

export function dropGhostPoolSeats(
  state: PoolReconcileState,
  inventoryEmails: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): string[] {
  const dropped: string[] = [];
  for (const row of state.listPoolMailboxes()) {
    const key = row.email.trim().toLowerCase();
    if (!key) continue;
    if (row.status !== "available" && row.status !== "assigned") continue;
    const present =
      inventoryEmails instanceof Map
        ? inventoryEmails.has(key)
        : inventoryEmails.has(key);
    if (present) continue;
    state.removePoolMailbox(key);
    dropped.push(key);
  }
  return dropped;
}
