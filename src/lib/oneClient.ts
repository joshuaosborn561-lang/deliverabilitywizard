/**
 * D26 / D75 — one inbox, one client. Many campaigns for that client are
 * fine. Another client's campaign is not.
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
