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
    /** D198 — true when mailboxClientId is Generic/POC marker, not a real client. */
    markerClientId?: boolean;
  },
): number | null {
  // D76 — free-pool generics belong to Goliath even with a leftover
  // client_id or an empty field.
  // D198 — *dedicated* generics (Josh 2026-09-21): a pool mailbox whose
  // client_id is set to a real named client is owned by that client, not
  // Goliath. one-client must not foreign-pull it off that client's
  // campaigns or rewrite its signature back to the POC brand.
  if (
    opts?.generic &&
    typeof opts.genericOwnerId === "number" &&
    Number.isFinite(opts.genericOwnerId)
  ) {
    if (
      typeof mailboxClientId === "number" &&
      Number.isFinite(mailboxClientId) &&
      mailboxClientId !== opts.genericOwnerId &&
      !opts.markerClientId
    ) {
      return mailboxClientId;
    }
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
