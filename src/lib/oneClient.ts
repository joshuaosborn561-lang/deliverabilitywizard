/**
 * D26 / D75 / D200 — one inbox, one client. Many campaigns for that
 * client are fine on *named* seats. Pool generics stay exclusive
 * (one live campaign). Another client's campaign is never fine.
 */

export interface MembershipRow {
  campaignId: number;
  clientId: number | null;
  shell: boolean;
}

export function ownerClientId(
  mailboxClientId: number | null | undefined,
  memberships: MembershipRow[],
  opts?: {
    generic?: boolean;
    genericOwnerId?: number | null;
    /** D198 — named-client dedicated generic; wins over the D76 Goliath owner. */
    dedicatedClientId?: number | null;
  },
): number | null {
  // D198 — a generic dedicated to a named client belongs to that client,
  // not Goliath. Multi-client links still peel via foreignCampaignIds.
  if (
    typeof opts?.dedicatedClientId === "number" &&
    Number.isFinite(opts.dedicatedClientId)
  ) {
    return opts.dedicatedClientId;
  }
  // D76 — rotating / undedicated pool generics belong to Goliath even
  // when a leftover client_id is empty. Dedicated named-client seats
  // are handled above (D198).
  if (
    opts?.generic &&
    typeof opts.genericOwnerId === "number" &&
    Number.isFinite(opts.genericOwnerId)
  ) {
    return opts.genericOwnerId;
  }
  if (typeof mailboxClientId === "number" && Number.isFinite(mailboxClientId)) {
    return mailboxClientId;
  }
  const ids = [
    ...new Set(
      memberships
        .filter((row) => !row.shell && typeof row.clientId === "number")
        .map((row) => row.clientId as number),
    ),
  ];
  return ids.length === 1 ? ids[0]! : null;
}

/** Campaigns this inbox must leave so it only serves its owner client. */
export function foreignCampaignIds(
  ownerId: number | null,
  memberships: MembershipRow[],
): number[] {
  if (ownerId == null) return [];
  return memberships
    .filter(
      (row) =>
        !row.shell &&
        typeof row.clientId === "number" &&
        row.clientId !== ownerId,
    )
    .map((row) => row.campaignId);
}

/**
 * D200 — campaigns to unlink.
 *
 * Named (non-pool) seats: foreign-client memberships only. Same-client
 * multi-link (techevolution* on two TechEvo camps) is allowed.
 *
 * Pool generics: foreign-client memberships **plus** extra same-client
 * live links. Exclusive-attach / no-multi-link is pool-only. Keep the
 * last keepable live membership; peel the extras (floor-gated by the
 * caller). Shells never count.
 */
export function peelCampaignIds(
  ownerId: number | null,
  memberships: MembershipRow[],
  opts?: { poolGeneric?: boolean },
): number[] {
  const foreign = foreignCampaignIds(ownerId, memberships);
  if (!opts?.poolGeneric) return foreign;
  const keepable = memberships.filter(
    (row) =>
      !row.shell &&
      !foreign.includes(row.campaignId) &&
      (typeof row.clientId !== "number" ||
        ownerId == null ||
        row.clientId === ownerId),
  );
  if (keepable.length <= 1) return foreign;
  const extras = keepable.slice(0, -1).map((row) => row.campaignId);
  return [...foreign, ...extras];
}
