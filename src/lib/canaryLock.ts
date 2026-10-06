/**
 * D238 — the copy-canary fleet is hard-locked. Six seats, warmup
 * permanently off, never staffing, never on a live campaign (D54/D55/D83).
 * Identify by registered copyCanary fleet membership first, then the
 * two-line `Canary` signature as a backstop when fleet state is stale.
 *
 * 2026-10-05: leilasanchez@getcrosslaunchco.info (Smartlead 22637921)
 * was tagged GENERIC+POD-A, client_id 521881, and fan-out-linked to
 * all six ACTIVE TechEvo campaigns because min40 treated a
 * PREWARMED/EXTRA_GENERIC-domain canary as pool supply when
 * isCopyCanary was false. Nothing may attach, tag, or assign these
 * seats again.
 *
 * D239 — GABE-VM-RESERVED seats are not named staffable inventory.
 * D241 — mutating stages never unlink, link, retag, or rewrite them.
 */

function accountEmailOf(account: {
  from_email?: string | null;
  email?: string | null;
}): string {
  return String(account.from_email ?? account.email ?? "")
    .trim()
    .toLowerCase();
}

function campaignIdsOfAccount(account: { campaign_ids?: unknown }): number[] {
  if (!Array.isArray(account.campaign_ids)) return [];
  return account.campaign_ids
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
}
import { isCanaryShellCampaign } from "./canaryShell.js";
import {
  isCopyCanaryFleetEmail,
  type CopyCanaryFleetRecord,
} from "./copyCanaryFleet.js";
import { mailboxTagNames } from "./markerClients.js";

export const CANARY_SIGNATURE_BRAND = "Canary";
export const GABE_VM_RESERVED_TAG = "GABE-VM-RESERVED";

export const CANARY_LOCK_CORE_KINDS = [
  "canary_on_live",
  "canary_warmup_on",
] as const;

export type CanaryLockCoreKind = (typeof CANARY_LOCK_CORE_KINDS)[number];

export interface CanaryLockFinding {
  kind: CanaryLockCoreKind;
  email: string;
  detail: string;
}

export type CanaryLockState = {
  isCopyCanary?: (email: string) => boolean;
  getCopyCanaryFleet?: () => CopyCanaryFleetRecord | null | undefined;
};

/** Last line (or any line) of the mailbox signature is the Canary brand. */
export function isCanarySignature(signature: string | null | undefined): boolean {
  const text = String(signature ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return false;
  return text.split("\n").some((line) => line.trim().toLowerCase() === "canary");
}

export function isGabeVmReserved(account: {
  tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
}): boolean {
  return mailboxTagNames({ tags: account.tags ?? [] }).some(
    (name) => name.toUpperCase() === GABE_VM_RESERVED_TAG,
  );
}

/** Campaigns that already have a GABE-VM-RESERVED seat linked (D241). */
export function gabeVmReservedCampaignIds(
  accounts: Array<{
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    campaign_ids?: unknown;
  }>,
): number[] {
  const ids = new Set<number>();
  for (const account of accounts) {
    if (!isGabeVmReserved(account)) continue;
    for (const campaignId of campaignIdsOfAccount(account)) {
      ids.add(campaignId);
    }
  }
  return [...ids];
}

export function isLockedCanarySeat(
  account: { signature?: string | null },
  email: string,
  state: CanaryLockState = {},
): boolean {
  const key = email.trim().toLowerCase();
  if (!key.includes("@")) return false;
  if (state.isCopyCanary?.(key)) return true;
  if (isCopyCanaryFleetEmail(key, state.getCopyCanaryFleet?.() ?? null)) {
    return true;
  }
  return isCanarySignature(account.signature);
}

export function canaryLockFindingLine(finding: CanaryLockFinding): string {
  return `${finding.kind}: ${finding.detail}`;
}

export function validateCanaryLock(input: {
  accounts: Array<{
    from_email?: string | null;
    email?: string | null;
    signature?: string | null;
    warmup_details?: { status?: string | null } | null;
    campaign_ids?: unknown;
  }>;
  campaigns?: Array<{ id?: number | null; name?: string | null }>;
  state?: CanaryLockState;
}): CanaryLockFinding[] {
  const campaignById = new Map(
    (input.campaigns ?? []).map((row) => [Number(row.id), row]),
  );
  const findings: CanaryLockFinding[] = [];
  for (const account of input.accounts) {
    const email = accountEmailOf(account);
    if (!email.includes("@")) continue;
    if (!isLockedCanarySeat(account, email, input.state)) continue;
    const warmupOn =
      String(account.warmup_details?.status ?? "").toUpperCase() === "ACTIVE";
    if (warmupOn) {
      findings.push({
        kind: "canary_warmup_on",
        email,
        detail: `${email} has warmup on (D83/D238)`,
      });
    }
    for (const campaignId of campaignIdsOfAccount(account)) {
      const campaign = campaignById.get(campaignId);
      if (campaign && isCanaryShellCampaign(campaign)) continue;
      findings.push({
        kind: "canary_on_live",
        email,
        detail: `${email} is linked to non-canary campaign #${campaignId} (D55/D238)`,
      });
    }
  }
  return findings;
}

export function canaryLockAlertText(findings: string[]): string {
  return [
    ":rotating_light: CANON miss: canary fleet was touched (D54/D55/D83/D238)",
    ...findings.map((line) => `• ${line}`),
    "The 6-seat canary fleet is hard-locked: warmup off, never staffing, never on a live campaign.",
    "Identify by copyCanary fleet membership or the Canary signature. Investigate in-thread.",
  ].join("\n");
}
