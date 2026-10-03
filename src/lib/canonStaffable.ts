/**
 * D217 — Canon staffing matches the Deliverability agent's verdict.
 *
 * The pre-agent checker paged "not enough inboxes" on campaigns that
 * already had ≥40 on-week staffable seats (SalesGlider 2026-10-03:
 * #3847939, #3847993, #3847995, #4006388, #4006389, #3739758,
 * #3748375 at 41/41), and missed real holes (TechEvo #3730560: 41
 * linked / 34 staffable, 7 Vasco SMTP fails).
 *
 * Staffable here is a seat that can actually send on the on-week POD:
 * SMTP/IMAP ok, campaign mpd > 0, warmup ≥21 days when a clock is
 * readable, correct client (or that client's dedicated generic),
 * on-week POD tag (off-week tagged seats do not count), not a canary,
 * not HOLD/RETIRE, not InboxKit-lapsed when the store knows.
 *
 * The live page floor is 40 on-week staffable, not
 * max(named on-week inventory, 40). Inventory 40-A + 40-B is unchanged.
 */

import type { SmartleadEmailAccount } from "../types/index.js";
import { hasHoldOrRetireTag, ON_WEEK_MIN_SENDERS } from "./clientStaffFloor.js";
import { normalizeSenderEspFamily } from "./esp.js";
import { readMessagePerDay } from "./mailboxSendSettings.js";
import { onWeekCohort, type RestCohort } from "./restCohort.js";
import { isConnectedAccount } from "./staffableSender.js";
import {
  daysSince,
  isWarmupGateExempt,
  tagNames,
  warmupClockStartedAt,
} from "../services/warmupGate.js";

const POD_A = "POD-A";
const POD_B = "POD-B";

export const CANON_STAFFABLE_MIN = ON_WEEK_MIN_SENDERS;

export type CanonStaffableReason =
  | "smtp_fail"
  | "imap_fail"
  | "mpd0"
  | "under_warmed"
  | "foreign_client"
  | "off_week_pod"
  | "canary"
  | "held"
  | "inboxkit_lapsed";

export interface CanonStaffableInput {
  account: Pick<
    SmartleadEmailAccount,
    | "id"
    | "client_id"
    | "type"
    | "from_email"
    | "email"
    | "is_smtp_success"
    | "is_imap_success"
    | "message_per_day"
    | "max_email_per_day"
    | "warmup_details"
    | "tags"
    | "created_at"
  >;
  email: string;
  campaignClientId?: number | null;
  /** Dedicated-generic owner when the mailbox is a client-signed generic. */
  dedicatedClientId?: number | null;
  copyCanary?: boolean;
  inboxKitLapsed?: boolean;
  /**
   * Readable warmup days. When set and < 21 (and not exempt), the seat
   * is not staffable. Missing clocks do not fail this check — the
   * separate `under_warmed` finding still pages those.
   */
  warmupDays?: number | null;
  warmupExempt?: boolean;
  now?: Date;
}

export interface CanonStaffableVerdict {
  ok: boolean;
  reasons: CanonStaffableReason[];
  onWeek: boolean;
  pod: RestCohort | null;
}

export function mailboxPodTag(
  account: Pick<SmartleadEmailAccount, "tags">,
): RestCohort | null {
  const tags = (account.tags ?? [])
    .map((t) => String(t.tag_name ?? t.name ?? "").trim().toUpperCase())
    .filter(Boolean);
  const hasA = tags.includes(POD_A);
  const hasB = tags.includes(POD_B);
  if (hasA && !hasB) return "A";
  if (hasB && !hasA) return "B";
  return null;
}

/** Off-week POD tag is not on-week staffable. Untagged seats are not excluded. */
export function seatIsOnWeekPod(
  account: Pick<SmartleadEmailAccount, "tags">,
  now: Date = new Date(),
): boolean {
  const pod = mailboxPodTag(account);
  if (!pod) return true;
  return pod === onWeekCohort(now);
}

export function accountMatchesCampaignClient(
  account: Pick<SmartleadEmailAccount, "client_id">,
  campaignClientId?: number | null,
  dedicatedClientId?: number | null,
): boolean {
  if (campaignClientId == null || !Number.isFinite(campaignClientId)) {
    return true;
  }
  if (account.client_id === campaignClientId) return true;
  if (dedicatedClientId === campaignClientId) return true;
  // Null client_id is an unassigned / in-flight generic — not a foreign client.
  if (account.client_id == null) return true;
  return false;
}

function warmupDaysOf(
  account: CanonStaffableInput["account"],
  email: string,
): number | null {
  const started = warmupClockStartedAt(account, email, {
    getPoolMailbox: () => undefined,
  });
  if (!started) return null;
  const days = daysSince(started);
  return Number.isFinite(days) ? days : null;
}

export function canonStaffableVerdict(
  input: CanonStaffableInput,
): CanonStaffableVerdict {
  const reasons: CanonStaffableReason[] = [];
  const now = input.now ?? new Date();
  const account = input.account;
  const pod = mailboxPodTag(account);
  const onWeek = seatIsOnWeekPod(account, now);

  if (account.is_smtp_success === false) reasons.push("smtp_fail");
  if (account.is_imap_success === false) reasons.push("imap_fail");

  const mpd = readMessagePerDay(account);
  if (Number.isFinite(mpd) && mpd <= 0) reasons.push("mpd0");

  if (input.copyCanary) reasons.push("canary");
  if (input.inboxKitLapsed) reasons.push("inboxkit_lapsed");
  if (hasHoldOrRetireTag(account, now)) reasons.push("held");

  const exempt =
    input.warmupExempt === true || isWarmupGateExempt(tagNames(account));
  const days =
    input.warmupDays !== undefined
      ? input.warmupDays
      : warmupDaysOf(account, input.email);
  if (!exempt && days != null && days < 21) reasons.push("under_warmed");

  if (
    !accountMatchesCampaignClient(
      account,
      input.campaignClientId,
      input.dedicatedClientId,
    )
  ) {
    reasons.push("foreign_client");
  }

  if (!onWeek) reasons.push("off_week_pod");

  return { ok: reasons.length === 0, reasons, onWeek, pod };
}

export function isCanonStaffable(input: CanonStaffableInput): boolean {
  return canonStaffableVerdict(input).ok;
}

export function summarizeCanonUnstaffable(
  verdicts: Array<{ reasons: CanonStaffableReason[] }>,
): Record<CanonStaffableReason, number> {
  const counts = {
    smtp_fail: 0,
    imap_fail: 0,
    mpd0: 0,
    under_warmed: 0,
    foreign_client: 0,
    off_week_pod: 0,
    canary: 0,
    held: 0,
    inboxkit_lapsed: 0,
  } satisfies Record<CanonStaffableReason, number>;
  for (const row of verdicts) {
    for (const reason of row.reasons) counts[reason] += 1;
  }
  return counts;
}

export function formatCanonStaffFloorDetail(input: {
  staffable: number;
  linked: number;
  floor?: number;
  unstaffable?: Record<string, number>;
}): string {
  const floor = input.floor ?? CANON_STAFFABLE_MIN;
  const bits = Object.entries(input.unstaffable ?? {})
    .filter(([, n]) => Number(n) > 0)
    .map(([reason, n]) => `${reason} ${n}`);
  const extra = bits.length ? `; ${bits.join(", ")}` : "";
  return `on-week staffable ${input.staffable}/${floor} (linked ${input.linked}${extra})`;
}

export function senderEspBucket(
  account: Pick<SmartleadEmailAccount, "type">,
): "outlook" | "gmail" | "other" {
  const family = normalizeSenderEspFamily(account.type);
  if (family === "microsoft") return "outlook";
  if (family === "google") return "gmail";
  return "other";
}

/** Kept so peel / reconnect still treat unknown SMTP as connected. */
export { isConnectedAccount };
