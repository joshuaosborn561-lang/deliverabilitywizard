/**
 * D243 — a seat on a client-named domain is that client's named
 * seat. Tagged to that client, split into that client's PODs,
 * never GENERIC, never the shared pool.
 *
 * Culture Fits 418275 / culturefits* stays a D192 leftover pending
 * Josh — do not classify, migrate, or retag those seats.
 */

import { isBcpOwnedDomain } from "./bcp.js";
import {
  BCP_CLIENT_ID,
  EMCOR_CLIENT_ID,
  PARLAY_CLIENT_ID,
  POWERGRYD_CLIENT_ID,
  TECHEVO_CLIENT_ID,
} from "./autoAllowGenerics.js";
import { assignClientCohorts, type RestCohort } from "./restCohort.js";
import { genericSeatKey } from "./genericPool.js";
import { GOLIATH_CLIENT_ID } from "./holdPolicy.js";
import { INSIGHT_CLIENT_ID, SALESGLIDER_CLIENT_ID } from "./insightCampaigns.js";
import { emailDomainOf } from "./isolationDomain.js";
import { DEEP_ROOTS_CLIENT_ID } from "./pocClient.js";
import { existingPodTag, type PodSide } from "./podTagLock.js";
import type { StateStore } from "../state/store.js";

export const CULTURE_FITS_CLIENT_ID = 418275;

export const CULTURE_FITS_DOMAIN_TOKENS = [
  "culturefits",
  "culturefit",
] as const;

/**
 * Known brand slugs Josh listed plus the short forms list_clients
 * already yields (goliath from "Goliath Cybersecurity", boldercyper
 * from the BCP typo brand). Longest match wins.
 */
export const CLIENT_NAMED_DOMAIN_SLUGS = [
  "goliathcybersecurity",
  "techevolution",
  "salesglider",
  "boldercyber",
  "boldercyper",
  "joshosborn",
  "cornerstone",
  "deeproots",
  "powergryd",
  "goliath",
  "insight",
  "parlay",
  "nutter",
  "vector",
  "emcor",
  "roofs",
  "mesa",
] as const;

const SLUG_OWNER: Record<string, number> = {
  goliathcybersecurity: GOLIATH_CLIENT_ID,
  goliath: GOLIATH_CLIENT_ID,
  techevolution: TECHEVO_CLIENT_ID,
  salesglider: SALESGLIDER_CLIENT_ID,
  boldercyber: BCP_CLIENT_ID,
  boldercyper: BCP_CLIENT_ID,
  emcor: EMCOR_CLIENT_ID,
  mesa: EMCOR_CLIENT_ID,
  parlay: PARLAY_CLIENT_ID,
  insight: INSIGHT_CLIENT_ID,
  joshosborn: INSIGHT_CLIENT_ID,
  powergryd: POWERGRYD_CLIENT_ID,
  deeproots: DEEP_ROOTS_CLIENT_ID,
};

const SLUGS_LONGEST_FIRST = [...CLIENT_NAMED_DOMAIN_SLUGS].sort(
  (a, b) => b.length - a.length,
);

export function clientNamedDomainBase(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

export function isCultureFitsDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  const base = clientNamedDomainBase(domain);
  if (!base) return false;
  return CULTURE_FITS_DOMAIN_TOKENS.some((token) => base.includes(token));
}

export function clientNamedSlugInDomain(
  domain: string | undefined,
): string | null {
  if (!domain) return null;
  if (isCultureFitsDomain(domain)) return null;
  const base = clientNamedDomainBase(domain);
  if (!base) return null;
  for (const slug of SLUGS_LONGEST_FIRST) {
    if (base.includes(slug)) return slug;
  }
  return null;
}

/** Known-slug match only — safe for markerClients (no list_clients). */
export function isClientNamedSlugDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  if (isCultureFitsDomain(domain)) return false;
  if (isBcpOwnedDomain(domain)) return true;
  return clientNamedSlugInDomain(domain) != null;
}

function tokensFromClient(client: {
  id?: number;
  name?: string | null;
  logo?: string | null;
}): string[] {
  if (client.id === CULTURE_FITS_CLIENT_ID) return [];
  const tokens = new Set<string>();
  for (const source of [client.name, client.logo]) {
    const text = String(source ?? "").toLowerCase();
    if (text === "generic" || text === "poc") continue;
    const words = text.split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some((word) => CULTURE_FITS_DOMAIN_TOKENS.includes(word as (typeof CULTURE_FITS_DOMAIN_TOKENS)[number]))) {
      return [];
    }
    for (const word of words) {
      if (word.length >= 6) tokens.add(word);
    }
    const joined = words.join("");
    if (joined.length >= 6) tokens.add(joined);
  }
  return [...tokens];
}

export function isClientNamedDomain(
  domain: string | undefined,
  clients: Array<{ id: number; name?: string | null; logo?: string | null }> = [],
): boolean {
  if (!domain) return false;
  if (isCultureFitsDomain(domain)) return false;
  if (isClientNamedSlugDomain(domain)) return true;
  const base = clientNamedDomainBase(domain);
  if (!base || !clients.length) return false;
  const matches = clients.filter((client) =>
    tokensFromClient(client).some((token) => base.includes(token)),
  );
  return matches.length === 1;
}

export function clientNamedOwnerForDomain(
  domain: string | undefined,
  clients: Array<{ id: number; name?: string | null; logo?: string | null }> = [],
): { clientId: number; clientName: string } | null {
  if (!domain || isCultureFitsDomain(domain)) return null;
  const slug = clientNamedSlugInDomain(domain);
  if (slug && SLUG_OWNER[slug]) {
    const clientId = SLUG_OWNER[slug]!;
    const named = clients.find((client) => client.id === clientId);
    return {
      clientId,
      clientName: String(named?.logo ?? named?.name ?? clientId),
    };
  }
  if (isBcpOwnedDomain(domain)) {
    const named = clients.find((client) => client.id === BCP_CLIENT_ID);
    return {
      clientId: BCP_CLIENT_ID,
      clientName: String(named?.logo ?? named?.name ?? "BCP"),
    };
  }
  const base = clientNamedDomainBase(domain);
  if (!base || !clients.length) return null;
  const matches = clients
    .filter((client) =>
      tokensFromClient(client).some((token) => base.includes(token)),
    )
    .map((client) => ({
      clientId: client.id,
      clientName: String(client.logo ?? client.name ?? client.id),
    }));
  return matches.length === 1 ? matches[0]! : null;
}

export function isClientNamedMailbox(
  email: string | undefined,
  clients: Array<{ id: number; name?: string | null; logo?: string | null }> = [],
): boolean {
  return isClientNamedDomain(emailDomainOf(email), clients);
}

/**
 * Static A/B for a client's named seats. Already-tagged POD-A/POD-B
 * stay put (D234). Only untagged seats take a first-tag from the
 * ESP-balanced remainder split.
 */
export function planClientNamedPodSplit(
  seats: Array<{
    email: string;
    type?: string | null;
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null;
  }>,
): Map<string, PodSide> {
  const out = new Map<string, PodSide>();
  const untagged: Array<{ email: string; type?: string | null }> = [];
  for (const seat of seats) {
    const email = seat.email.trim().toLowerCase();
    if (!email.includes("@")) continue;
    const existing = existingPodTag(seat.tags);
    if (existing) {
      out.set(email, existing);
      continue;
    }
    untagged.push({ email, type: seat.type });
  }
  const cohorts = assignClientCohorts(untagged);
  for (const row of untagged) {
    const cohort: RestCohort = cohorts.get(row.email) ?? "A";
    out.set(row.email, cohort);
  }
  return out;
}

export interface ClientNamedPoolMigration {
  removedPool: string[];
  droppedSeats: string[];
  alreadyTagged: string[];
  untagged: string[];
}

/**
 * Pull leftover pool-mailbox + generic-table rows off client-named
 * domains so they cannot be GENERIC / min40 supply / cleanup dirt.
 * Does not write Smartlead. Does not touch Culture Fits. Does not
 * re-split already-tagged POD seats.
 */
export function migrateClientNamedPoolRecords(input: {
  state: Pick<
    StateStore,
    | "listPoolMailboxes"
    | "removePoolMailbox"
    | "listGenericSeats"
    | "replaceGenericSeats"
  >;
  accounts?: Array<{
    from_email?: string | null;
    email?: string | null;
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null;
  }>;
  clients?: Array<{ id: number; name?: string | null; logo?: string | null }>;
}): ClientNamedPoolMigration {
  const clients = input.clients ?? [];
  const result: ClientNamedPoolMigration = {
    removedPool: [],
    droppedSeats: [],
    alreadyTagged: [],
    untagged: [],
  };

  const namedEmails = new Set<string>();
  const consider = (email: string | undefined) => {
    const key = String(email ?? "").trim().toLowerCase();
    if (!key.includes("@")) return;
    if (!isClientNamedMailbox(key, clients)) return;
    namedEmails.add(key);
  };

  for (const row of input.state.listPoolMailboxes()) consider(row.email);
  for (const row of input.state.listGenericSeats()) consider(row.email);
  for (const account of input.accounts ?? []) {
    consider(String(account.from_email ?? account.email ?? ""));
  }

  for (const email of namedEmails) {
    if (input.state.listPoolMailboxes().some((row) => row.email.toLowerCase() === email)) {
      input.state.removePoolMailbox(email);
      result.removedPool.push(email);
    }
  }

  const kept = input.state.listGenericSeats().filter((seat) => {
    const email = genericSeatKey(seat.email);
    if (!namedEmails.has(email) && !isClientNamedMailbox(email, clients)) {
      return true;
    }
    result.droppedSeats.push(email);
    return false;
  });
  if (result.droppedSeats.length) {
    input.state.replaceGenericSeats(kept);
  }

  const seats = (input.accounts ?? [])
    .map((account) => ({
      email: String(account.from_email ?? account.email ?? "")
        .trim()
        .toLowerCase(),
      tags: account.tags,
    }))
    .filter((row) => namedEmails.has(row.email));
  const plan = planClientNamedPodSplit(seats);
  for (const row of seats) {
    const existing = existingPodTag(row.tags);
    if (existing) result.alreadyTagged.push(row.email);
    else if (plan.has(row.email)) result.untagged.push(row.email);
  }

  if (result.removedPool.length || result.droppedSeats.length) {
    console.log(
      `[client-named] migrated pool=${result.removedPool.length} generic-seats=${result.droppedSeats.length} already-tagged=${result.alreadyTagged.length} untagged=${result.untagged.length} (D243)`,
    );
  }
  return result;
}
