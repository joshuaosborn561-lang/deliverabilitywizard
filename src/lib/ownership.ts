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
 *    `include_tags=true`) → that slug's legacy client id.
 *  - D332 — wizard shells (canary shell, pod control shell, word hunt shell)
 *    are ATTRIBUTED to an owner — their own unique sg-owner tag, else the
 *    parent campaign's (`Canary shell: #<parentId> …`) — exposed as
 *    `owner_slug` / `owner_client_id`. Their `client_id` stays the raw
 *    Smartlead value (null), so every consumer that keys real client
 *    campaigns by `client_id` (staffing, POD counts, one-client, top-up,
 *    canon counts, …) still sees a shell as unowned. Ownership only.
 *  - Mailbox owner = a wizard override (written when the wizard moves a
 *    mailbox) → the raw client_id while spaces still exist → the committed
 *    seed captured from the 2026-11-11 client_id (src/data/mailboxOwnerSeed.ts)
 *    → the unique sg-owner owner of the campaigns it sends on (named seats
 *    only; GENERIC / POC / CANARY boxes never inherit a campaign owner;
 *    shells never count) → unassigned (pool), exactly as a null-client
 *    mailbox is treated today. D332: new mailboxes are registered into the
 *    override book through `POST /ownership/mailboxes` (source
 *    "onboarding_api"); campaign inference is live and never persisted.
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

/**
 * D332 — parent campaign id of a canary shell (`Canary shell: #<id> …`).
 * Same pattern as canaryShell.liveCampaignIdFromCanaryShellName (kept local
 * to avoid the import cycle; the ownership test pins them together).
 */
export function shellParentCampaignId(name: string | null | undefined): number | null {
  const match = String(name ?? "").trim().match(/^canary shell:\s+#(\d+)/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Override book — wizard writes that used to set Smartlead client_id.
// ---------------------------------------------------------------------------

export interface OwnershipOverride {
  /** Legacy owner client id, or null = unassigned / pool. */
  clientId: number | null;
  at: string;
  source?: string;
  /**
   * D332 — the sg-owner slug when the writer knew it (onboarding API). Lets
   * an owner with no legacy id (cornerstone, vasco, …) keep its slug while
   * `clientId` stays null exactly as its campaigns do.
   */
  slug?: string;
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
        ...(typeof v.slug === "string" && ownerCatalogEntry(v.slug) ? { slug: v.slug } : {}),
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
  campaignSlugCache.clear();
}

function recordOverride(
  book: "accounts" | "campaigns",
  id: number,
  clientId: number | null,
  source?: string,
  slug?: string,
): void {
  if (!Number.isFinite(id) || id <= 0) return;
  overrides[book][String(id)] = {
    clientId,
    at: new Date().toISOString(),
    ...(source ? { source } : {}),
    ...(slug ? { slug } : {}),
  };
  onOverridesChanged?.(overrides);
}

export function recordAccountOwner(
  accountId: number,
  clientId: number | null,
  source?: string,
  slug?: string,
): void {
  recordOverride("accounts", accountId, clientId, source, slug);
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
  | "shell_sg_owner_tag"
  | "shell_parent_sg_owner_tag"
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
  /**
   * The id every consumer keys client campaigns / mailboxes by (stamped as
   * `client_id`). For a shell this stays the raw Smartlead value so the
   * shell is never counted as a client campaign (D332).
   */
  clientId: number | null;
  slug: string | null;
  reason: OwnershipReason;
  /**
   * D332 — attributed owner (legacy id of `slug`). Equal to `clientId` for
   * real campaigns and mailboxes; for a shell it is the owner it belongs
   * to while `clientId` stays raw.
   */
  ownerClientId: number | null;
}

/**
 * D332 — who a wizard shell belongs to. Its own unique sg-owner tag wins
 * (explicit beats inherited, and a shell retagged by hand is believed);
 * ambiguous own tags (two distinct sg-owner slugs) are unowned and do NOT
 * fall back to the parent; no own tag → the parent campaign's unique
 * sg-owner slug (canary shells only — `Canary shell: #<parentId>`).
 */
export function resolveShellOwner(
  shell: CampaignOwnerInput,
  parentSlug: (parentId: number) => string | null | undefined,
): { slug: string | null; reason: OwnershipReason } {
  const own = sgOwnerSlugs(shell.tags);
  if (own.length === 1) return { slug: own[0]!, reason: "shell_sg_owner_tag" };
  if (own.length > 1) return { slug: null, reason: "shell" };
  const parentId = shellParentCampaignId(shell.name);
  const id = finiteId(shell.id);
  if (parentId !== null && parentId !== id) {
    const slug = parentSlug(parentId);
    if (slug) return { slug, reason: "shell_parent_sg_owner_tag" };
  }
  return { slug: null, reason: "shell" };
}

export function resolveCampaignOwner(
  campaign: CampaignOwnerInput,
  opts: {
    overrides?: OwnershipOverrideState;
    /** D332 — sg-owner slug of a parent campaign (for canary shells). */
    parentSlug?: (parentId: number) => string | null | undefined;
  } = {},
): ResolvedOwner {
  const book = opts.overrides ?? overrides;
  const id = finiteId(campaign.id);
  const raw = finiteId(campaign.client_id);
  // Shells were never in a client space: client_id stays raw so no consumer
  // treats a shell as a client campaign. D332 attributes the owner only.
  if (isWizardShellCampaignName(campaign.name)) {
    const shell = resolveShellOwner(campaign, opts.parentSlug ?? cachedCampaignSlug);
    if (shell.slug) {
      return {
        clientId: raw,
        slug: shell.slug,
        reason: shell.reason,
        ownerClientId: legacyClientIdForSlug(shell.slug),
      };
    }
    return { clientId: raw, slug: slugForLegacyClientId(raw), reason: "shell", ownerClientId: raw };
  }
  // The sg-owner tag is the truth (D331); it beats a wizard override.
  const slug = sgOwnerSlug(campaign.tags);
  const legacy = slug ? legacyClientIdForSlug(slug) : null;
  if (slug && legacy !== null) return withOwner({ clientId: legacy, slug, reason: "sg_owner_tag" });
  const override = id !== null ? book.campaigns[String(id)] : undefined;
  if (override) {
    return withOwner({
      clientId: override.clientId,
      slug: slug ?? override.slug ?? slugForLegacyClientId(override.clientId),
      reason: "override",
    });
  }
  if (slug) return withOwner({ clientId: raw, slug, reason: "sg_owner_tag_no_space" });
  if (raw !== null) return withOwner({ clientId: raw, slug: slugForLegacyClientId(raw), reason: "raw_client_id" });
  return withOwner({ clientId: null, slug: null, reason: "unassigned" });
}

function withOwner(owner: Omit<ResolvedOwner, "ownerClientId">): ResolvedOwner {
  return { ...owner, ownerClientId: owner.clientId };
}

/**
 * Owner ids of campaigns seen on the last list / get (feeds mailbox
 * derivation). Shells are noted with their raw (null) client_id, so a
 * shell never makes a mailbox inherit an owner.
 */
const campaignOwnerCache = new Map<number, number | null>();
/** D332 — unique sg-owner slug of each NON-shell campaign seen (shell parent lookup). */
const campaignSlugCache = new Map<number, string | null>();

export function noteCampaignOwner(campaignId: number, clientId: number | null): void {
  if (Number.isFinite(campaignId)) campaignOwnerCache.set(campaignId, clientId);
}

export function cachedCampaignOwner(campaignId: number): number | null | undefined {
  return campaignOwnerCache.get(campaignId);
}

export function cachedCampaignSlug(campaignId: number): string | null | undefined {
  return campaignSlugCache.get(campaignId);
}

const NEVER_INHERIT_TAGS = new Set(["GENERIC", "POC", "CANARY"]);

/** D332 — pool / POC / canary boxes: never inherit, never onboarded to a client. */
export function isPoolOrCanaryMailbox(tags: readonly TagLike[] | null | undefined): boolean {
  return (tags ?? []).some((t) => NEVER_INHERIT_TAGS.has(tagName(t).trim().toUpperCase()));
}

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
    return withOwner({
      clientId: override.clientId,
      slug: override.slug ?? slugForLegacyClientId(override.clientId),
      reason: "override",
    });
  }
  const raw = finiteId(account.client_id);
  if (raw !== null) return withOwner({ clientId: raw, slug: slugForLegacyClientId(raw), reason: "raw_client_id" });
  const seeded = id !== null ? seed.get(id) : undefined;
  if (seeded) {
    return withOwner({ clientId: legacyClientIdForSlug(seeded), slug: seeded, reason: "seed" });
  }
  if (!isPoolOrCanaryMailbox(account.tags)) {
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
      return withOwner({ clientId: only, slug: slugForLegacyClientId(only), reason: "campaign_tags" });
    }
  }
  return withOwner({ clientId: null, slug: null, reason: "unassigned" });
}

let seedMap: Map<number, string> | null = null;
export function seedById(): ReadonlyMap<number, string> {
  if (!seedMap) {
    seedMap = new Map(MAILBOX_OWNER_SEED.map((row) => [row.id, row.slug]));
  }
  return seedMap;
}

let seedEmailMap: Map<string, number> | null = null;
/** D332 — seeded mailbox id by lowercased from_email. */
export function seedIdByEmail(email: string | null | undefined): number | undefined {
  if (!seedEmailMap) {
    seedEmailMap = new Map(MAILBOX_OWNER_SEED.map((row) => [row.from_email.toLowerCase(), row.id]));
  }
  return email ? seedEmailMap.get(email.trim().toLowerCase()) : undefined;
}

/**
 * Stamp a Smartlead campaign in place: client_id becomes the resolved
 * legacy owner id and `owner_slug` the sg-owner slug. Idempotent.
 */
type StampedCampaign = CampaignOwnerInput & {
  owner_slug?: string | null;
  owner_client_id?: number | null;
  owner_reason?: string;
};

export function applyCampaignOwnership<T extends StampedCampaign>(
  campaign: T,
  opts: { parentSlug?: (parentId: number) => string | null | undefined } = {},
): T {
  if (!campaign || typeof campaign !== "object") return campaign;
  const owner = resolveCampaignOwner(campaign, opts.parentSlug ? { parentSlug: opts.parentSlug } : {});
  campaign.client_id = owner.clientId;
  campaign.owner_slug = owner.slug;
  campaign.owner_client_id = owner.ownerClientId;
  campaign.owner_reason = owner.reason;
  const id = finiteId(campaign.id);
  if (id !== null) {
    noteCampaignOwner(id, owner.clientId);
    if (!isWizardShellCampaignName(campaign.name)) campaignSlugCache.set(id, owner.slug);
  }
  return campaign;
}

/**
 * D332 — stamp a whole campaign list: real campaigns first, then shells,
 * so a canary shell finds its parent's sg-owner tag in the SAME list
 * (falling back to the last-seen cache for a parent not in the list).
 */
export function applyCampaignOwnershipToList<T extends StampedCampaign>(campaigns: T[]): T[] {
  const slugById = new Map<number, string | null>();
  for (const campaign of campaigns) {
    if (!campaign || typeof campaign !== "object" || isWizardShellCampaignName(campaign.name)) continue;
    applyCampaignOwnership(campaign);
    const id = finiteId(campaign.id);
    if (id !== null) slugById.set(id, campaign.owner_slug ?? null);
  }
  const parentSlug = (parentId: number) =>
    slugById.has(parentId) ? slugById.get(parentId) : cachedCampaignSlug(parentId);
  for (const campaign of campaigns) {
    if (!campaign || typeof campaign !== "object" || !isWizardShellCampaignName(campaign.name)) continue;
    applyCampaignOwnership(campaign, { parentSlug });
  }
  return campaigns;
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

// ---------------------------------------------------------------------------
// D332 — onboarding: register new mailboxes into the override book.
// ---------------------------------------------------------------------------

export const ONBOARDING_OWNER_SOURCE = "onboarding_api";

/** Public label for where a mailbox's owner came from. */
export type MailboxOwnerSource = "override" | "raw_client_id" | "seed" | "campaign_inference" | "none";

export function mailboxOwnerSource(reason: OwnershipReason): MailboxOwnerSource {
  switch (reason) {
    case "override":
      return "override";
    case "raw_client_id":
      return "raw_client_id";
    case "seed":
      return "seed";
    case "campaign_tags":
      return "campaign_inference";
    default:
      return "none";
  }
}

export interface MailboxAssignmentInput {
  accountId: number;
  email?: string;
  slug: string;
}

export type MailboxAssignmentResult =
  | {
      accountId: number;
      slug: string;
      clientId: number | null;
      status: "created" | "updated" | "unchanged";
      /** Where the owner already came from when unchanged. */
      via?: "seed" | "override";
      previous?: { slug: string | null; clientId: number | null; source?: string };
      warning?: string;
    }
  | {
      accountId: number;
      slug: string;
      status: "conflict";
      reason: string;
      current: { slug: string | null; clientId: number | null; source: string };
    };

/**
 * Apply one onboarding assignment. Idempotent: re-asserting the owner a
 * mailbox already has (seed or override) writes nothing. Only mailboxes
 * with no owner yet — or one an earlier onboarding call set — are written;
 * a seeded mailbox or one the wizard moved is never reassigned from here
 * (that is a client move, not onboarding). The slug must already be
 * validated against OWNER_CATALOG.
 */
export function assignMailboxOwner(input: MailboxAssignmentInput): MailboxAssignmentResult {
  const slug = input.slug.trim().toLowerCase();
  const clientId = legacyClientIdForSlug(slug);
  const accountId = input.accountId;
  const warning =
    clientId === null
      ? `sg-owner:${slug} has no legacy client id; the wizard treats this mailbox as unassigned, exactly like ${slug}'s campaigns (D331)`
      : undefined;
  const existing = overrides.accounts[String(accountId)];
  const seeded = seedById().get(accountId);
  if (existing) {
    const currentSlug = existing.slug ?? slugForLegacyClientId(existing.clientId);
    if (existing.clientId === clientId && currentSlug === slug) {
      return { accountId, slug, clientId, status: "unchanged", via: "override", ...(warning ? { warning } : {}) };
    }
    if (existing.source !== ONBOARDING_OWNER_SOURCE) {
      return {
        accountId,
        slug,
        status: "conflict",
        reason: `mailbox already owned via override (${existing.source ?? "unknown"}); moving it between clients is not an onboarding action — ask Josh`,
        current: { slug: currentSlug, clientId: existing.clientId, source: `override:${existing.source ?? "unknown"}` },
      };
    }
    recordAccountOwner(accountId, clientId, ONBOARDING_OWNER_SOURCE, slug);
    return {
      accountId,
      slug,
      clientId,
      status: "updated",
      previous: { slug: currentSlug, clientId: existing.clientId, source: existing.source },
      ...(warning ? { warning } : {}),
    };
  }
  if (seeded) {
    if (seeded === slug) {
      return { accountId, slug, clientId, status: "unchanged", via: "seed", ...(warning ? { warning } : {}) };
    }
    return {
      accountId,
      slug,
      status: "conflict",
      reason: "mailbox is in the D331 seed under another owner; the seed is never reassigned from onboarding — ask Josh",
      current: { slug: seeded, clientId: legacyClientIdForSlug(seeded), source: "seed" },
    };
  }
  recordAccountOwner(accountId, clientId, ONBOARDING_OWNER_SOURCE, slug);
  return { accountId, slug, clientId, status: "created", ...(warning ? { warning } : {}) };
}
