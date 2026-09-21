/**
 * D198 — a generic mailbox dedicated to one named client.
 *
 * Marks (first match wins):
 *   1. pool-mailbox `assignedClientId`
 *   2. Smartlead mailbox `client_id` (the client tag)
 *   3. a `client:<id>` mailbox tag
 *
 * The POC / Goliath owner is *not* a dedicated named-client assignment —
 * those seats stay on the rotating generic pool (D76 / D43 send-clock).
 * Marker Generic/POC ids are never an owner (D160).
 *
 * Dedicated seats belong to that client: one-client / generic-rest /
 * pullNonGoliathGenerics must not treat them as foreign Goliath when
 * they sit on that client's campaigns. Multi-client links still peel.
 */

export function isRealNamedClientId(
  id: number | null | undefined,
  isMarkerClientId?: (id: number | null | undefined) => boolean,
): boolean {
  if (typeof id !== "number" || !Number.isFinite(id)) return false;
  if (isMarkerClientId?.(id)) return false;
  return true;
}

export interface DedicatedGenericOpts {
  /** POC / Goliath — rotating pool, not a named-client dedication. */
  genericOwnerId?: number | null;
  isMarkerClientId?: (id: number | null | undefined) => boolean;
}

export interface DedicatedGenericAccount {
  client_id?: number | null;
  tags?: Array<{ tag_name?: unknown; name?: unknown }>;
}

export interface DedicatedGenericState {
  getPoolMailbox: (email: string) =>
    | { assignedClientId?: number | null }
    | undefined;
  isMarkerClientId?: (id: number | null | undefined) => boolean;
}

function clientIdFromTags(
  account: DedicatedGenericAccount,
  isMarkerClientId?: (id: number | null | undefined) => boolean,
): number | null {
  for (const tag of account.tags ?? []) {
    const name = String(tag.tag_name ?? tag.name ?? "").trim();
    if (!name) continue;
    const match = /^client[:_-](\d+)$/i.exec(name);
    if (!match) continue;
    const id = Number(match[1]);
    if (isRealNamedClientId(id, isMarkerClientId)) return id;
  }
  return null;
}

/**
 * Named client this generic is dedicated to, or null when it is still
 * rotating pool / POC-owned (D76).
 */
export function dedicatedGenericClientId(
  account: DedicatedGenericAccount,
  email: string,
  state: DedicatedGenericState,
  opts: DedicatedGenericOpts = {},
): number | null {
  const isMarker = opts.isMarkerClientId ?? state.isMarkerClientId;
  const pool = state.getPoolMailbox(email.trim().toLowerCase());
  const candidates = [
    pool?.assignedClientId,
    account.client_id,
    clientIdFromTags(account, isMarker),
  ];
  for (const candidate of candidates) {
    if (!isRealNamedClientId(candidate, isMarker)) continue;
    if (
      typeof opts.genericOwnerId === "number" &&
      candidate === opts.genericOwnerId
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}

export function isDedicatedToClient(
  account: DedicatedGenericAccount,
  email: string,
  clientId: number | null | undefined,
  state: DedicatedGenericState,
  opts: DedicatedGenericOpts = {},
): boolean {
  if (!isRealNamedClientId(clientId, opts.isMarkerClientId ?? state.isMarkerClientId)) {
    return false;
  }
  return dedicatedGenericClientId(account, email, state, opts) === clientId;
}
