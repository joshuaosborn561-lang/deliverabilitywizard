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
): number | null {
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
