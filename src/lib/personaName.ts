/**
 * Real-persona rule — a mailbox name is never invented.
 *
 * Prod incident 2026-10-29: min40-topup / campaign top-up / pool import
 * fell back to the literals "Pool" / "User" when a seat had no named pool
 * row, so Smartlead from_name became "Pool User" and the signature
 * "Pool User\n<brand>" (which passes every from_name-vs-signature match).
 * A prospect received an email signed "Pool User Emcor".
 *
 * Josh, 2026-10-29: "Every inbox has a name. ... If no name just send as
 * the company. But everyone should have a name."
 *
 * Persona sources, in order: the seat's pool row (set from the Generics
 * Ledger / InboxKit import), then the name already on the live Smartlead
 * mailbox when it is a real person, then — when the seat has no persona —
 * the client's company name as the from_name (signature = the company
 * name alone). The assign is never refused for a missing persona, and a
 * placeholder ("Pool User") is never written. Nothing here invents a name.
 */

/** Whole-word tokens that mark a name as a placeholder, not a person. */
export const PLACEHOLDER_NAME_TOKENS: readonly string[] = [
  "pool",
  "generic",
  "canary",
  "test",
  "placeholder",
  "sample",
  "demo",
  "dummy",
  "temp",
  "spare",
  "mailbox",
  "sender",
  "user",
  "admin",
  "team",
  "noreply",
  "unknown",
  "none",
  "null",
  "tbd",
  "default",
  "box",
];

const PLACEHOLDER_SET = new Set(PLACEHOLDER_NAME_TOKENS);
const PLACEHOLDER_WHOLE = new Set(["n/a", "na", "n a"]);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\s'’-]/gu, " ")
    .split(/[\s]+/)
    .map((t) => t.replace(/^['’-]+|['’-]+$/g, ""))
    .filter(Boolean);
}

/**
 * True when `name` is blank, one word, contains a placeholder token
 * (whole word, case/punctuation-insensitive), or is the email local part.
 * `email` is optional: when given, a name equal to its local part is a
 * placeholder too (the local part is a login, not a persona).
 */
export function isPlaceholderPersonName(
  name: string | null | undefined,
  email?: string | null,
): boolean {
  const raw = (name ?? "").trim();
  if (!raw) return true;
  if (PLACEHOLDER_WHOLE.has(raw.toLowerCase())) return true;
  const tokens = nameTokens(raw);
  if (tokens.length < 2) return true;
  if (tokens.some((t) => PLACEHOLDER_SET.has(t))) return true;
  const local = (email ?? "").split("@")[0]?.trim().toLowerCase();
  // The raw login used as the name ("wilhelmina", "pool.user"). A real
  // two-part name that happens to equal firstlast@ ("Brett Oakley" for
  // brettoakley@) is a persona, not a placeholder.
  if (local && raw.toLowerCase() === local) return true;
  return false;
}

export interface SeatPersona {
  firstName: string;
  lastName: string;
  /** Where the name came from — for logs only. */
  source: "pool-row" | "live-mailbox";
}

function normalizeNameKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

/** Split a real name; returns null (never a default) for a placeholder. */
export function personaFromName(
  name: string | null | undefined,
  email?: string | null,
): { firstName: string; lastName: string } | null {
  if (isPlaceholderPersonName(name, email)) return null;
  return splitName(name as string);
}

/**
 * Resolve the persona a seat may carry onto a client campaign.
 * Returns null when the seat has none — the caller must refuse the assign
 * (log reason `placeholder-persona`) and write nothing.
 */
export function resolveSeatPersona(input: {
  email: string;
  pool?: { firstName?: string | null; lastName?: string | null } | null;
  liveFromName?: string | null;
  /**
   * Client company names. A mailbox that already sends "as the company"
   * (from_name = "Bolder Cyber Partners") carries no persona, so that name
   * is never reused as a person on another client.
   */
  knownBrands?: readonly string[];
}): SeatPersona | null {
  const brandKeys = new Set(
    (input.knownBrands ?? []).map(normalizeNameKey).filter(Boolean),
  );
  const isBrand = (name: string) => brandKeys.has(normalizeNameKey(name));
  const poolName = `${input.pool?.firstName ?? ""} ${input.pool?.lastName ?? ""}`.trim();
  const fromPool = isBrand(poolName) ? null : personaFromName(poolName, input.email);
  if (fromPool) return { ...fromPool, source: "pool-row" };
  const live = (input.liveFromName ?? "").trim();
  const fromLive = isBrand(live) ? null : personaFromName(live, input.email);
  if (fromLive) return { ...fromLive, source: "live-mailbox" };
  return null;
}

export interface SendIdentity {
  /** Smartlead from_name to write. Never a placeholder. */
  fromName: string;
  /** Mailbox signature to write. Never contains a placeholder. */
  signature: string;
  /** Present only for a person; blank when sending as the company. */
  firstName: string;
  lastName: string;
  source: "pool-row" | "live-mailbox" | "company";
}

/** The company name is an acceptable sender name (not a placeholder). */
export function isCompanySenderName(
  name: string | null | undefined,
  clientBrand: string | null | undefined,
): boolean {
  const n = (name ?? "").trim().toLowerCase();
  const b = (clientBrand ?? "").trim().toLowerCase();
  return Boolean(n) && n === b;
}

/**
 * The identity a seat sends as on a client's campaign: persona if it has
 * one, else the client company name. Returns null only when there is no
 * persona AND no company name (nothing real to send as) — the caller then
 * skips that seat and logs it.
 */
export function resolveSendIdentity(input: {
  email: string;
  pool?: { firstName?: string | null; lastName?: string | null } | null;
  liveFromName?: string | null;
  clientBrand: string;
  knownBrands?: readonly string[];
}): SendIdentity | null {
  const brand = (input.clientBrand ?? "").trim();
  const persona = resolveSeatPersona({
    ...input,
    knownBrands: [...(input.knownBrands ?? []), brand],
  });
  if (persona) {
    const fromName = `${persona.firstName} ${persona.lastName}`.trim();
    return {
      fromName,
      signature: brand ? `${fromName}\n${brand}` : fromName,
      firstName: persona.firstName,
      lastName: persona.lastName,
      source: persona.source,
    };
  }
  // No persona and no usable company name (blank, or a bare client id): there
  // is nothing real to send as.
  if (!brand || /^\d+$/.test(brand)) return null;
  return {
    fromName: brand,
    signature: brand,
    firstName: "",
    lastName: "",
    source: "company",
  };
}

/** One log line for a no-persona assign. Never includes lead data. */
export function logPlaceholderRefusal(
  where: string,
  email: string,
  liveFromName?: string | null,
): void {
  console.warn(
    `[placeholder-persona] ${where}: ${email} has nothing real to send as (live from_name=${JSON.stringify(
      (liveFromName ?? "").slice(0, 60),
    )}) — skipped, nothing written`,
  );
}

/** Log that a seat without a persona will send as the company. */
export function logCompanyFallback(
  where: string,
  email: string,
  brand: string,
  liveFromName?: string | null,
): void {
  console.warn(
    `[placeholder-persona] ${where}: ${email} has no persona (live from_name=${JSON.stringify(
      (liveFromName ?? "").slice(0, 60),
    )}) — sending as the company "${brand}"`,
  );
}
