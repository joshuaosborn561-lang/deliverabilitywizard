import { nameHayMatches } from "./clientWipe.js";

/**
 * D70 — a POC client sends on generic domains (Goliath first).
 * Those assigned generics A/B with the client. Unassigned pool
 * generics still use the send clock (D43).
 */
export const DEFAULT_POC_CLIENT_PATTERNS = ["goliath"];

export function isPocHay(
  hay: string,
  patterns: string[] = DEFAULT_POC_CLIENT_PATTERNS,
): boolean {
  return nameHayMatches(hay, patterns);
}

export function pocStaffPatterns(
  genericStaff: string[],
  poc: string[],
): string[] {
  return [
    ...new Set(
      [...genericStaff, ...poc]
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Client name plus every campaign for that client — not just current membership. */
export function pocClientHay(
  clientId: number | null | undefined,
  campaigns: Array<{ name?: string | null; client_id?: number | null }>,
  clients: Array<{ id?: number; name?: string | null }> = [],
  extra = "",
): string {
  const clientName =
    typeof clientId === "number"
      ? (clients.find((client) => client.id === clientId)?.name ?? "")
      : "";
  const campaignNames =
    typeof clientId === "number"
      ? campaigns
          .filter((campaign) => campaign.client_id === clientId)
          .map((campaign) => campaign.name ?? "")
      : [];
  return [extra, clientName, ...campaignNames].join(" ");
}

/**
 * Hay for a mailbox that may already be sitting (no campaign ids).
 * Goliath's Smartlead client is "Dave Ackley" — match campaign names.
 */
export function pocHayForAccount(
  account: { client_id?: number | null },
  email: string,
  membershipIds: number[],
  campaigns: Array<{
    id?: number;
    name?: string | null;
    client_id?: number | null;
  }>,
  clients: Array<{ id?: number; name?: string | null }> = [],
): string {
  let clientId =
    typeof account.client_id === "number" && Number.isFinite(account.client_id)
      ? account.client_id
      : null;
  if (clientId == null) {
    for (const id of membershipIds) {
      const campaign = campaigns.find((row) => row.id === id);
      if (typeof campaign?.client_id === "number") {
        clientId = campaign.client_id;
        break;
      }
    }
  }
  return pocClientHay(
    clientId,
    campaigns,
    clients,
    [
      email,
      ...membershipIds.map(
        (id) => campaigns.find((campaign) => campaign.id === id)?.name ?? "",
      ),
    ].join(" "),
  );
}
