import { brandInText } from "./clientBrand.js";
import { POWERGRYD_CLIENT_ID } from "./namedClientIds.js";
import { isFreedPowerGrydPoolOwner } from "./powerGrydFreedCleanup.js";
import { signatureHay } from "./signatureQa.js";

/**
 * D198 / D199 — a generic mailbox dedicated to one named client.
 *
 * Marks (first match wins):
 *   1. D258 — live Smartlead `client_id` when it and the pool
 *      `assignedClientId` are different real named clients
 *   1b. D283 — live Smartlead `client_id=null` is authoritative for
 *      Onboarding-freed seats: a stale PowerGRYD / `powergryd_dedicated`
 *      pool row is not an owner
 *   2. pool-mailbox `assignedClientId` (wins over leftover /
 *      marker / Goliath mailbox ids — D198)
 *   3. Smartlead mailbox `client_id` when the pool has no named owner
 *   4. a `client:<id>` mailbox tag
 *   5. D199 — exclusive attach on one named client's campaigns
 *      *and* a signature (or from-name) carrying that client's brand
 *
 * The POC / Goliath owner is *not* a dedicated named-client assignment —
 * those seats stay on the rotating generic pool (D76 / D43 send-clock).
 * Marker Generic/POC ids are never an owner (D160).
 *
 * Dedicated seats belong to that client: one-client / generic-rest /
 * pullNonGoliathGenerics / client-rest must not treat them as foreign
 * Goliath when they sit on that client's campaigns. Multi-client links
 * still peel (floor-gated).
 */

export function isRealNamedClientId(
  id: number | null | undefined,
  isMarkerClientId?: (id: number | null | undefined) => boolean,
): id is number {
  if (typeof id !== "number" || !Number.isFinite(id)) return false;
  if (isMarkerClientId?.(id)) return false;
  return true;
}

export interface DedicatedGenericOpts {
  /** POC / Goliath — rotating pool, not a named-client dedication. */
  genericOwnerId?: number | null;
  isMarkerClientId?: (id: number | null | undefined) => boolean;
  /**
   * D199 — exclusive attach on this named client plus a matching
   * client signature is dedication even without client_id / tag.
   */
  exclusiveClientId?: number | null;
  clientBrand?: string | null;
}

export interface DedicatedGenericAccount {
  client_id?: number | null;
  tags?: Array<{ tag_name?: unknown; name?: unknown }>;
  from_name?: string | null;
  signature?: string | null;
}

export interface DedicatedMembershipHint {
  clientId: number | null;
  shell?: boolean;
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
 * D258 — live Smartlead `client_id` wins when it and the pool
 * assignment are different real named clients. A leftover marker /
 * Goliath / empty mailbox id still loses to a current pool
 * assignment (D198).
 */
export function preferredGenericOwnerId(input: {
  mailboxClientId?: number | null;
  assignedClientId?: number | null;
  assignedReason?: string | null;
  powerGrydClientId?: number;
  isMarkerClientId?: (id: number | null | undefined) => boolean;
  genericOwnerId?: number | null;
}): number | null {
  const isNamed = (id: number | null | undefined): id is number => {
    if (!isRealNamedClientId(id, input.isMarkerClientId)) return false;
    if (
      typeof input.genericOwnerId === "number" &&
      id === input.genericOwnerId
    ) {
      return false;
    }
    return true;
  };
  const mailbox = input.mailboxClientId;
  const assigned = input.assignedClientId;
  if (isNamed(mailbox) && isNamed(assigned) && mailbox !== assigned) {
    return mailbox;
  }
  // D283 — Onboarding-freed: live Smartlead null wins over a stale
  // PowerGRYD pool assignment / powergryd_dedicated reason.
  if (
    isFreedPowerGrydPoolOwner({
      mailboxClientId: mailbox,
      assignedClientId: assigned,
      assignedReason: input.assignedReason,
      powerGrydClientId: input.powerGrydClientId ?? POWERGRYD_CLIENT_ID,
    })
  ) {
    return null;
  }
  if (isNamed(assigned)) return assigned;
  if (isNamed(mailbox)) return mailbox;
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
  const isMarker =
    opts.isMarkerClientId ??
    (typeof state.isMarkerClientId === "function"
      ? (id: number | null | undefined) => state.isMarkerClientId!(id)
      : undefined);
  const pool = state.getPoolMailbox(email.trim().toLowerCase());
  const preferred = preferredGenericOwnerId({
    mailboxClientId: account.client_id,
    assignedClientId: pool?.assignedClientId,
    isMarkerClientId: isMarker,
    genericOwnerId: opts.genericOwnerId,
  });
  if (preferred != null) return preferred;
  const tagged = clientIdFromTags(account, isMarker);
  if (
    isRealNamedClientId(tagged, isMarker) &&
    !(
      typeof opts.genericOwnerId === "number" &&
      tagged === opts.genericOwnerId
    )
  ) {
    return tagged;
  }
  return dedicatedFromExclusiveClientSig(account, opts, isMarker);
}

/**
 * One named client across non-shell memberships, or null when the
 * mailbox is multi-client / unmarked (D199).
 */
export function exclusiveNamedClientId(
  memberships: DedicatedMembershipHint[],
  opts: DedicatedGenericOpts = {},
): number | null {
  const ids = [
    ...new Set(
      memberships
        .filter((row) => !row.shell)
        .map((row) => row.clientId)
        .filter((id): id is number =>
          isRealNamedClientId(id, opts.isMarkerClientId),
        ),
    ),
  ].filter((id) => {
    if (typeof opts.genericOwnerId === "number" && id === opts.genericOwnerId) {
      return false;
    }
    return true;
  });
  return ids.length === 1 ? ids[0]! : null;
}

function dedicatedFromExclusiveClientSig(
  account: DedicatedGenericAccount,
  opts: DedicatedGenericOpts,
  isMarker?: (id: number | null | undefined) => boolean,
): number | null {
  const exclusive = opts.exclusiveClientId;
  if (!isRealNamedClientId(exclusive, isMarker)) return null;
  if (
    typeof opts.genericOwnerId === "number" &&
    exclusive === opts.genericOwnerId
  ) {
    return null;
  }
  const brand = String(opts.clientBrand ?? "").trim();
  if (!brand) return null;
  const hay = signatureHay({
    fromName: account.from_name,
    signature: account.signature,
  });
  if (!brandInText(hay, brand)) return null;
  return exclusive;
}

/**
 * D198 marks first, then D199 exclusive attach + client-sig.
 */
export function resolveDedicatedGenericClientId(
  account: DedicatedGenericAccount,
  email: string,
  memberships: DedicatedMembershipHint[],
  state: DedicatedGenericState,
  opts: DedicatedGenericOpts & { brandByClientId?: Map<number, string> } = {},
): number | null {
  const exclusive =
    opts.exclusiveClientId ?? exclusiveNamedClientId(memberships, opts);
  const brand =
    opts.clientBrand ??
    (exclusive != null ? opts.brandByClientId?.get(exclusive) : undefined);
  return dedicatedGenericClientId(account, email, state, {
    ...opts,
    exclusiveClientId: exclusive,
    clientBrand: brand,
  });
}

export function isDedicatedToClient(
  account: DedicatedGenericAccount,
  email: string,
  clientId: number | null | undefined,
  state: DedicatedGenericState,
  opts: DedicatedGenericOpts = {},
): boolean {
  const isMarker =
    opts.isMarkerClientId ??
    (typeof state.isMarkerClientId === "function"
      ? (id: number | null | undefined) => state.isMarkerClientId!(id)
      : undefined);
  if (!isRealNamedClientId(clientId, isMarker)) {
    return false;
  }
  return dedicatedGenericClientId(account, email, state, opts) === clientId;
}
