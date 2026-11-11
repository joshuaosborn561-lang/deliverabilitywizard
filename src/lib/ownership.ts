/**
 * D331 — Smartlead client spaces are deleted; ownership comes from tags.
 *
 * Josh deleted every Smartlead client space (sub-client) on 2026-11-11.
 * Deleting a space keeps campaigns, leads, tags, sequences and stats but
 * nulls `campaign.client_id` and the mailbox `client_id`. The wizard keys
 * everything (POD counts, pool / GENERIC classification, fan-out, top-up,
 * ops and sends boards, totals, Slack) by the numeric Smartlead client id,
 * so instead of rewriting ~90 consumers we resolve ownership ONCE at the
 * Smartlead client boundary and hand every consumer the same numeric
 * owner id it saw before the deletion:
 *
 *  - Campaign owner = its unique `sg-owner:<slug>` tag (read with
 *    `include_tags=true`) → that slug's legacy client id. Wizard shells
 *    (canary shell, pod control shell, word hunt shell) stay unowned exactly
 *    as before even though some carry their parent's tag.
 *  - Mailbox owner = a wizard override (written when the wizard moves a
 *    mailbox) → the raw client_id while spaces still exist → the committed
 *    seed captured from the 2026-11-11 client_id (src/data/mailboxOwnerSeed.ts)
 *    → the unique sg-owner owner of the campaigns it sends on (named seats
 *    only; GENERIC / POC / CANARY boxes never inherit a campaign owner) →
 *    unassigned (pool), exactly as a null-client mailbox is treated today.
 *  - Client records (`listClients`) come from OWNER_CATALOG, with today's
 *    names and logos, so clientDisplayName output is unchanged.
 *  - Client writes (campaign client_id, mailbox client_id) never reach
 *    Smartlead: they land in the persisted override book instead and can
 *    never fail because the space is gone.
 */

import { MAILBOX_OWNER_SEED } from "../data/mailboxOwnerSeed.js";

export const SG_OWNER_TAG_PREFIX = "sg-owner:";

export interface OwnerCatalogEntry {
  slug: string;
  /** Smartlead client id the wizard keyed this owner by before D331 (null = never had a space). */
  legacyClientId: number | null;
  /** Today's Smartlead client record name / logo — keeps clientDisplayName identical. */
  name?: string;
  logo?: string | null;
  uuid?: string;
  email?: string;
}

/**
 * The 22 live sg-owner tags. legacyClientId / name / logo are copied from
 * Smartlead GET client/ on 2026-11-11 (spaces-backup/clients.json).
 * Ciotola shares SalesGlider's 345263 because that is where its campaigns
 * lived; the D325 virtual 900345263 split keys off campaign name / tag as
 * before. Slugs with null legacyClientId never had a space, so the wizard
 * treated their campaigns as unassigned and still does.
 */
export const OWNER_CATALOG: readonly OwnerCatalogEntry[] = [
  { slug: "salesglider", legacyClientId: 345263, name: "SalesGlider", logo: "SalesGlider", email: "joshua@salesglidergrowth.com", uuid: "a1d004cb-08eb-4d1c-8ae5-686f9382e57d" },
  { slug: "parlay", legacyClientId: 418274, name: "Randy Haba", logo: "Parlay Tech" },
  { slug: "culture_fits", legacyClientId: 418275, name: "TJ Johnson", logo: "Culture Fits" },
  { slug: "techevo", legacyClientId: 521881, name: "Corey Tapper", logo: "TechEvolution" },
  { slug: "bcp", legacyClientId: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" },
  { slug: "peterson", legacyClientId: 548610, name: "Kyle Peterson", logo: "Roofs by Peterson" },
  { slug: "goliath", legacyClientId: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
  { slug: "nutter", legacyClientId: 566991, name: "Roger Nutter", logo: "Nutter Group" },
  { slug: "emcor", legacyClientId: 574020, name: "Myles McIntosh", logo: "Emcor" },
  { slug: "insight", legacyClientId: 582890, name: "Insight", logo: "Insight" },
  { slug: "powergryd", legacyClientId: 592842, name: "PowerGryd", logo: "PowerGRYD" },
  { slug: "vector", legacyClientId: 597119, name: "Vector Energy Group", logo: null },
  { slug: "bpltg", legacyClientId: 602897, name: "BPLTG", logo: "BPLTG" },
  { slug: "nexus", legacyClientId: 607522, name: "Nexus Dynamics Group", logo: "Nexus Dynamics Group" },
  { slug: "virtual_pulsar", legacyClientId: 607625, name: "Virtual Pulsar", logo: "Virtual Pulsar" },
  { slug: "ciotola", legacyClientId: 345263 },
  { slug: "cornerstone", legacyClientId: null },
  { slug: "deeproots", legacyClientId: null },
  { slug: "nieto", legacyClientId: null },
  { slug: "msrs", legacyClientId: null },
  { slug: "positive", legacyClientId: null },
  { slug: "vasco", legacyClientId: null },
];

const BY_SLUG = new Map(OWNER_CATALOG.map((e) => [e.slug, e]));

/** One record per legacy client id (first catalog entry wins: 345263 → SalesGlider). */
export function legacyClientRecords(): Array<{
  id: number;
  name?: string;
  logo?: string | null;
  email?: string;
  uuid?: string;
}> {
  const seen = new Set<number>();
  const out: Array<{ id: number; name?: string; logo?: string | null; email?: string; uuid?: string }> = [];
  for (const e of OWNER_CATALOG) {
    if (e.legacyClientId === null || seen.has(e.legacyClientId)) continue;
    seen.add(e.legacyClientId);
    out.push({
      id: e.legacyClientId,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(e.logo !== undefined ? { logo: e.logo } : {}),
      ...(e.email !== undefined ? { email: e.email } : {}),
      ...(e.uuid !== undefined ? { uuid: e.uuid } : {}),
    });
  }
  return out;
}

export function ownerCatalogEntry(slug: string | null | undefined): OwnerCatalogEntry | undefined {
  return slug ? BY_SLUG.get(slug.trim().toLowerCase()) : undefined;
}

export function legacyClientIdForSlug(slug: string | null | undefined): number | null {
  return ownerCatalogEntry(slug)?.legacyClientId ?? null;
}

/** Canonical slug for a legacy client id (345263 → salesglider). */
export function slugForLegacyClientId(clientId: number | null | undefined): string | null {
  if (typeof clientId !== "number") return null;
  for (const e of OWNER_CATALOG) if (e.legacyClientId === clientId) return e.slug;
  return null;
}

type TagLike = { tag_name?: unknown; name?: unknown } | string;

function tagName(tag: TagLike): string {
  return typeof tag === "string" ? tag : String(tag?.tag_name ?? tag?.name ?? "");
}

/** All distinct sg-owner slugs on a tag list (lowercased). */
export function sgOwnerSlugs(tags: readonly TagLike[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const tag of tags ?? []) {
    const name = tagName(tag).trim();
    if (name.toLowerCase().startsWith(SG_OWNER_TAG_PREFIX)) {
      const slug = name.slice(SG_OWNER_TAG_PREFIX.length).trim().toLowerCase();
      if (slug) out.add(slug);
    }
  }
  return [...out];
}

/** The unique sg-owner slug, or null when none / ambiguous. */
export function sgOwnerSlug(tags: readonly TagLike[] | null | undefined): string | null {
  const slugs = sgOwnerSlugs(tags);
  return slugs.length === 1 ? slugs[0]! : null;
}

export function sgOwnerTagName(slug: string): string {
  return `${SG_OWNER_TAG_PREFIX}${slug}`;
}

/**
 * Wizard-internal shells. Kept local (not imported from canaryShell /
 * podControlShell / wordHuntShell) to avoid an import cycle into the
 * Smartlead client; the guard test pins these to the real predicates.
 */
export function isWizardShellCampaignName(name: string | null | undefined): boolean {
  const n = String(name ?? "").trim().toLowerCase();
  return (
    n.startsWith("canary shell") ||
    n.startsWith("pod control shell") ||
    n === "dw word hunt shell"
  );
}

function finiteId(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Override book — wizard writes that used to set Smartlead client_id.
// ---------------------------------------------------------------------------

export interface OwnershipOverride {
  /** Legacy owner client id, or null = unassigned / pool. */
  clientId: number | null;
  at: string;
  source?: string;
}

export interface OwnershipOverrideState {
  accounts: Record<string, OwnershipOverride>;
  campaigns: Record<string, OwnershipOverride>;
}

export function emptyOwnershipOverrides(): OwnershipOverrideState {
  return { accounts: {}, campaigns: {} };
}

export function parseOwnershipOverrides(raw: unknown): OwnershipOverrideState {
  const out = emptyOwnershipOverrides();
  if (!raw || typeof raw !== "object") return out;
  for (const key of ["accounts", "campaigns"] as const) {
    const book = (raw as Record<string, unknown>)[key];
    if (!book || typeof book !== "object") continue;
    for (const [id, value] of Object.entries(book as Record<string, unknown>)) {
      if (!/^\d+$/.test(id) || !value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const clientId = v.clientId === null ? null : finiteId(v.clientId);
      if (clientId === null && v.clientId !== null) continue;
      out[key][id] = {
        clientId,
        at: typeof v.at === "string" ? v.at : new Date(0).toISOString(),
        ...(typeof v.source === "string" ? { source: v.source } : {}),
      };
    }
  }
  return out;
}

let overrides: OwnershipOverrideState = emptyOwnershipOverrides();
let onOverridesChanged: ((state: OwnershipOverrideState) => void) | null = null;

/** Boot: load the persisted book and register the persist hook. */
export function loadOwnershipOverrides(
  state: unknown,
  onChange?: (state: OwnershipOverrideState) => void,
): void {
  overrides = parseOwnershipOverrides(state);
  onOverridesChanged = onChange ?? null;
}

export function ownershipOverrides(): OwnershipOverrideState {
  return overrides;
}

/** Test-only. */
export function resetOwnershipForTests(): void {
  overrides = emptyOwnershipOverrides();
  onOverridesChanged = null;
  campaignOwnerCache.clear();
}

function recordOverride(
  book: "accounts" | "campaigns",
  id: number,
  clientId: number | null,
  source?: string,
): void {
  if (!Number.isFinite(id) || id <= 0) return;
  overrides[book][String(id)] = {
    clientId,
    at: new Date().toISOString(),
    ...(source ? { source } : {}),
  };
  onOverridesChanged?.(overrides);
}

export function recordAccountOwner(accountId: number, clientId: number | null, source?: string): void {
  recordOverride("accounts", accountId, clientId, source);
}

export function recordCampaignOwner(campaignId: number, clientId: number | null, source?: string): void {
  recordOverride("campaigns", campaignId, clientId, source);
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

export type OwnershipReason =
  | "override"
  | "shell"
  | "sg_owner_tag"
  | "sg_owner_tag_no_space"
  | "raw_client_id"
  | "seed"
  | "campaign_tags"
  | "unassigned";

export interface CampaignOwnerInput {
  id?: number | null;
  name?: string | null;
  client_id?: number | null;
  tags?: readonly TagLike[] | null;
}

export interface ResolvedOwner {
  clientId: number | null;
  slug: string | null;
  reason: OwnershipReason;
}

export function resolveCampaignOwner(
  campaign: CampaignOwnerInput,
  opts: { overrides?: OwnershipOverrideState } = {},
): ResolvedOwner {
  const book = opts.overrides ?? overrides;
  const id = finiteId(campaign.id);
  const raw = finiteId(campaign.client_id);
  // Shells were never in a client space; a copied parent tag must not
  // make them a client campaign.
  if (isWizardShellCampaignName(campaign.name)) {
    return { clientId: raw, slug: slugForLegacyClientId(raw), reason: "shell" };
  }
  // The sg-owner tag is the truth (D331); it beats a wizard override.
  const slug = sgOwnerSlug(campaign.tags);
  const legacy = slug ? legacyClientIdForSlug(slug) : null;
  if (slug && legacy !== null) return { clientId: legacy, slug, reason: "sg_owner_tag" };
  const override = id !== null ? book.campaigns[String(id)] : undefined;
  if (override) {
    return { clientId: override.clientId, slug: slug ?? slugForLegacyClientId(override.clientId), reason: "override" };
  }
  if (slug) return { clientId: raw, slug, reason: "sg_owner_tag_no_space" };
  if (raw !== null) return { clientId: raw, slug: slugForLegacyClientId(raw), reason: "raw_client_id" };
  return { clientId: null, slug: null, reason: "unassigned" };
}

/** Owner ids of campaigns seen on the last list / get (feeds mailbox derivation). */
const campaignOwnerCache = new Map<number, number | null>();

export function noteCampaignOwner(campaignId: number, clientId: number | null): void {
  if (Number.isFinite(campaignId)) campaignOwnerCache.set(campaignId, clientId);
}

export function cachedCampaignOwner(campaignId: number): number | null | undefined {
  return campaignOwnerCache.get(campaignId);
}

const NEVER_INHERIT_TAGS = new Set(["GENERIC", "POC", "CANARY"]);

export interface AccountOwnerInput {
  id?: number | null;
  client_id?: number | null;
  tags?: readonly TagLike[] | null;
  campaign_ids?: readonly number[] | null;
  campaigns?: ReadonlyArray<{ id?: number; campaign_id?: number }> | null;
}

export function resolveAccountOwner(
  account: AccountOwnerInput,
  opts: {
    overrides?: OwnershipOverrideState;
    seed?: ReadonlyMap<number, string>;
    campaignOwner?: (campaignId: number) => number | null | undefined;
  } = {},
): ResolvedOwner {
  const book = opts.overrides ?? overrides;
  const seed = opts.seed ?? seedById();
  const campaignOwner = opts.campaignOwner ?? cachedCampaignOwner;
  const id = finiteId(account.id);
  const override = id !== null ? book.accounts[String(id)] : undefined;
  if (override) {
    return { clientId: override.clientId, slug: slugForLegacyClientId(override.clientId), reason: "override" };
  }
  const raw = finiteId(account.client_id);
  if (raw !== null) return { clientId: raw, slug: slugForLegacyClientId(raw), reason: "raw_client_id" };
  const seeded = id !== null ? seed.get(id) : undefined;
  if (seeded) {
    return { clientId: legacyClientIdForSlug(seeded), slug: seeded, reason: "seed" };
  }
  const tagNames = (account.tags ?? []).map((t) => tagName(t).trim().toUpperCase());
  if (!tagNames.some((t) => NEVER_INHERIT_TAGS.has(t))) {
    const campaignIds = Array.isArray(account.campaign_ids) && account.campaign_ids.length
      ? account.campaign_ids
      : (account.campaigns ?? [])
          .map((c) => c.id ?? c.campaign_id)
          .filter((n): n is number => typeof n === "number");
    const owners = new Set<number>();
    for (const cid of campaignIds) {
      const owner = campaignOwner(cid);
      if (typeof owner === "number") owners.add(owner);
    }
    if (owners.size === 1) {
      const only = [...owners][0]!;
      return { clientId: only, slug: slugForLegacyClientId(only), reason: "campaign_tags" };
    }
  }
  return { clientId: null, slug: null, reason: "unassigned" };
}

let seedMap: Map<number, string> | null = null;
export function seedById(): ReadonlyMap<number, string> {
  if (!seedMap) {
    seedMap = new Map(MAILBOX_OWNER_SEED.map((row) => [row.id, row.slug]));
  }
  return seedMap;
}

/**
 * Stamp a Smartlead campaign in place: client_id becomes the resolved
 * legacy owner id and `owner_slug` the sg-owner slug. Idempotent.
 */
export function applyCampaignOwnership<T extends CampaignOwnerInput & { owner_slug?: string | null }>(
  campaign: T,
): T {
  if (!campaign || typeof campaign !== "object") return campaign;
  const owner = resolveCampaignOwner(campaign);
  campaign.client_id = owner.clientId;
  campaign.owner_slug = owner.slug;
  const id = finiteId(campaign.id);
  if (id !== null) noteCampaignOwner(id, owner.clientId);
  return campaign;
}

export function applyAccountOwnership<T extends AccountOwnerInput & { owner_slug?: string | null }>(
  account: T,
): T {
  if (!account || typeof account !== "object") return account;
  const owner = resolveAccountOwner(account);
  account.client_id = owner.clientId;
  account.owner_slug = owner.slug;
  return account;
}
