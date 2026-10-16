/**
 * D283 — hard attach exclusions, mirroring D282 Insight.
 *
 * CornerStone (574088) client seats and an unexpired HOLD-UNTIL tag
 * never attach. Existing memberships stay (D51/D128 — leftover
 * HOLD-UNTIL is not a pull). addEmailAccountsToCampaign rejects
 * both before any Smartlead write.
 */

import { CORNERSTONE_CLIENT_ID, isCornerstoneClientId } from "./namedClientIds.js";

export { CORNERSTONE_CLIENT_ID, isCornerstoneClientId };

export const HOLD_UNTIL_TAG_RE = /^HOLD-UNTIL-(\d{4}-\d{2}-\d{2})$/i;

export type AttachGuardAccount = {
  id?: number | null;
  client_id?: number | null;
  from_name?: string | null;
  from_email?: string | null;
  email?: string | null;
  username?: string | null;
  signature?: string | null;
  tags?: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null;
};

export function accountTagNames(
  account: { tags?: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null } | null | undefined,
): string[] {
  const out: string[] = [];
  for (const tag of account?.tags ?? []) {
    const name =
      typeof tag === "string"
        ? tag.trim()
        : String(tag.tag_name ?? tag.name ?? "").trim();
    if (name) out.push(name);
  }
  return out;
}

/** Unexpired HOLD-UNTIL-YYYY-MM-DD (end of that UTC day). */
export function activeHoldUntilTag(
  tags: string[],
  now: Date = new Date(),
): string | null {
  for (const tag of tags) {
    const match = HOLD_UNTIL_TAG_RE.exec(tag);
    if (!match) continue;
    const end = Date.parse(`${match[1]}T23:59:59.999Z`);
    if (Number.isFinite(end) && end >= now.getTime()) return match[1];
  }
  return null;
}

export function accountHasActiveHoldUntil(
  account: AttachGuardAccount | null | undefined,
  now: Date = new Date(),
): boolean {
  return activeHoldUntilTag(accountTagNames(account), now) != null;
}

export function isCornerstoneClientSeat(
  account: AttachGuardAccount | null | undefined,
): boolean {
  return isCornerstoneClientId(account?.client_id);
}

/**
 * D283 — never attach. Does not pull an existing membership.
 */
export function isAttachForbiddenSeat(
  account: AttachGuardAccount | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!account) return false;
  return isCornerstoneClientSeat(account) || accountHasActiveHoldUntil(account, now);
}

export class AttachForbiddenSeatError extends Error {
  readonly blockedIds: number[];
  readonly campaignId: number;

  constructor(campaignId: number, blockedIds: number[]) {
    super(
      `CornerStone client seats and HOLD-UNTIL tagged seats never attach (D283): campaign ${campaignId} blocked account ids ${blockedIds.join(",")}`,
    );
    this.name = "AttachForbiddenSeatError";
    this.blockedIds = blockedIds;
    this.campaignId = campaignId;
  }
}

/** One pass over the shared inventory book. Never fetches a seat. */
export function indexAttachForbiddenAccountIds(
  accounts: Iterable<AttachGuardAccount>,
  now: Date = new Date(),
): Set<number> {
  const out = new Set<number>();
  for (const account of accounts) {
    if (typeof account.id !== "number" || !Number.isFinite(account.id)) continue;
    if (isAttachForbiddenSeat(account, now)) out.add(account.id);
  }
  return out;
}

export function assertAttachAllowedAccountIds(
  campaignId: number,
  accountIds: number[],
  ctx: {
    accountsById: ReadonlyMap<number, AttachGuardAccount>;
    now?: Date;
  },
): void {
  const now = ctx.now ?? new Date();
  const blocked = accountIds.filter((id) => {
    const account = ctx.accountsById.get(id);
    if (!account) return false;
    return isAttachForbiddenSeat(account, now);
  });
  if (blocked.length) {
    throw new AttachForbiddenSeatError(campaignId, blocked);
  }
}
