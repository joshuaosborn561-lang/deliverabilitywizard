/**
 * D242 — CALLER FOLLOW-UP campaign class.
 *
 * Config-driven so more callers can be added later:
 *   CALLER_FOLLOWUP_CAMPAIGN_IDS   default 4085158,4085159,4085160
 *   CALLER_FOLLOWUP_NAME_PREFIX    default "Gabe Calls |"
 *   CALLER_FOLLOWUP_SENDER_TAG     default GABE-VM-RESERVED
 *
 * Today's caller is Gabe Lopez. The three gabriel@ bridge seats sit
 * in SalesGlider 345263 and serve all three campaigns. That is the
 * one-client-per-sender exception. Twelve owned gabe@ seats warm
 * for 21 days, then attach to that client's Gabe Calls campaign
 * only. Bridge seats come off by 2026-11-03.
 */

import { mailboxTagNames } from "./markerClients.js";

export const CALLER_FOLLOWUP_SENDER_TAG_DEFAULT = "GABE-VM-RESERVED";
export const CALLER_FOLLOWUP_NAME_PREFIX_DEFAULT = "Gabe Calls |";
export const CALLER_FOLLOWUP_CAMPAIGN_IDS_DEFAULT = [
  4085158, 4085159, 4085160,
] as const;

export const CALLER_FOLLOWUP_HOME_CLIENT_ID = 345263;
export const CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS = 3;
export const CALLER_FOLLOWUP_TIMEZONE = "America/Chicago";
export const CALLER_FOLLOWUP_START_HOUR = 7;
export const CALLER_FOLLOWUP_END_HOUR = 20;
/** Smartlead days_of_the_week: 1=Mon … 5=Fri. */
export const CALLER_FOLLOWUP_DAYS_OF_WEEK = [1, 2, 3, 4, 5] as const;
export const CALLER_FOLLOWUP_BRIDGE_REMOVE_BY = "2026-11-03";
export const CALLER_FOLLOWUP_CAP_RAMP_YMD = "2026-10-12";
export const CALLER_FOLLOWUP_CAP_RAMP_TO = 35;

export const CALLER_FOLLOWUP_BRIDGE_SENDERS = [
  { email: "gabriel@sorrelquotaio.co", id: 24255344 },
  { email: "gabriel@goldworkio.co", id: 24255318 },
  { email: "gabriel@solacecorehq.co", id: 24255314 },
] as const;

export const GABE_CALLS_SALESGLIDER_ID = 4085158;
export const GABE_CALLS_EMCOR_ID = 4085159;
export const GABE_CALLS_DEEP_ROOTS_ID = 4085160;

/** Four owned gabe@ domains per Gabe Calls campaign (still warming). */
export const CALLER_FOLLOWUP_OWNED_DOMAINS_BY_CAMPAIGN: Readonly<
  Record<number, readonly string[]>
> = {
  [GABE_CALLS_SALESGLIDER_ID]: [
    "gosalesglider.info",
    "trysalesglider.info",
    "salesglidersdr.info",
    "salesglidermrr.info",
  ],
  [GABE_CALLS_EMCOR_ID]: [
    "trymesaco.info",
    "trymesahq.info",
    "getmesaco.info",
    "getmesahq.info",
  ],
  [GABE_CALLS_DEEP_ROOTS_ID]: [
    "brightlanehq.info",
    "clearharborco.info",
    "northpeakteam.info",
    "steadfieldhq.info",
  ],
};

export const CALLER_FOLLOWUP_OWNED_LOCAL_PART = "gabe";

export interface CallerFollowUpPolicy {
  campaignIds: readonly number[];
  namePrefix: string;
  senderTag: string;
}

export const DEFAULT_CALLER_FOLLOWUP_POLICY: CallerFollowUpPolicy = {
  campaignIds: CALLER_FOLLOWUP_CAMPAIGN_IDS_DEFAULT,
  namePrefix: CALLER_FOLLOWUP_NAME_PREFIX_DEFAULT,
  senderTag: CALLER_FOLLOWUP_SENDER_TAG_DEFAULT,
};

export type CallerFollowUpConfigSlice = {
  callerFollowUpCampaignIds?: readonly number[];
  callerFollowUpNamePrefix?: string;
  callerFollowUpSenderTag?: string;
};

export function callerFollowUpPolicyFromConfig(
  config?: CallerFollowUpConfigSlice | null,
): CallerFollowUpPolicy {
  return {
    campaignIds:
      config?.callerFollowUpCampaignIds?.length
        ? config.callerFollowUpCampaignIds
        : DEFAULT_CALLER_FOLLOWUP_POLICY.campaignIds,
    namePrefix:
      config?.callerFollowUpNamePrefix?.trim() ||
      DEFAULT_CALLER_FOLLOWUP_POLICY.namePrefix,
    senderTag:
      config?.callerFollowUpSenderTag?.trim() ||
      DEFAULT_CALLER_FOLLOWUP_POLICY.senderTag,
  };
}

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function campaignIdsOfAccount(account: { campaign_ids?: unknown }): number[] {
  if (!Array.isArray(account.campaign_ids)) return [];
  return account.campaign_ids
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

const BRIDGE_EMAILS = new Set(
  CALLER_FOLLOWUP_BRIDGE_SENDERS.map((row) => row.email),
);
const BRIDGE_IDS = new Set(CALLER_FOLLOWUP_BRIDGE_SENDERS.map((row) => row.id));

const OWNED_DOMAIN_TO_CAMPAIGN = new Map<string, number>();
for (const [campaignId, domains] of Object.entries(
  CALLER_FOLLOWUP_OWNED_DOMAINS_BY_CAMPAIGN,
)) {
  const id = Number(campaignId);
  for (const domain of domains) {
    OWNED_DOMAIN_TO_CAMPAIGN.set(domain.toLowerCase(), id);
  }
}

export function isCallerFollowUpCampaign(
  campaign:
    | {
        id?: number | null;
        name?: string | null;
      }
    | null
    | undefined,
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  if (!campaign) return false;
  const id = Number(campaign.id);
  if (Number.isFinite(id) && policy.campaignIds.some((known) => Number(known) === id)) {
    return true;
  }
  const prefix = policy.namePrefix.trim();
  if (!prefix) return false;
  return String(campaign.name ?? "").startsWith(prefix);
}

export function isCallerFollowUpSenderTag(
  account: {
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
  },
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  const wanted = policy.senderTag.trim().toUpperCase();
  if (!wanted) return false;
  return mailboxTagNames({ tags: account.tags ?? [] }).some(
    (name) => name.toUpperCase() === wanted,
  );
}

export function isCallerFollowUpBridgeSender(account: {
  from_email?: string | null;
  email?: string | null;
  id?: number | null;
}): boolean {
  const email = normalizeEmail(account.from_email ?? account.email);
  if (email && BRIDGE_EMAILS.has(email)) return true;
  const id = Number(account.id);
  return Number.isFinite(id) && BRIDGE_IDS.has(id);
}

export function isCallerFollowUpOwnedSeat(email: string | null | undefined): boolean {
  const key = normalizeEmail(email);
  const at = key.indexOf("@");
  if (at <= 0) return false;
  const local = key.slice(0, at);
  const domain = key.slice(at + 1);
  return (
    local === CALLER_FOLLOWUP_OWNED_LOCAL_PART &&
    OWNED_DOMAIN_TO_CAMPAIGN.has(domain)
  );
}

export function callerFollowUpOwnedTargetCampaignId(
  email: string | null | undefined,
): number | null {
  const key = normalizeEmail(email);
  const at = key.indexOf("@");
  if (at <= 0) return null;
  if (key.slice(0, at) !== CALLER_FOLLOWUP_OWNED_LOCAL_PART) return null;
  return OWNED_DOMAIN_TO_CAMPAIGN.get(key.slice(at + 1)) ?? null;
}

/**
 * Class senders: the CALLER_FOLLOWUP tag (GABE-VM-RESERVED today)
 * or a known bridge gabriel@ seat. Owned gabe@ boxes are regular
 * until they clear warmup and attach.
 */
export function isCallerFollowUpSender(
  account: {
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  },
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return (
    isCallerFollowUpSenderTag(account, policy) ||
    isCallerFollowUpBridgeSender(account)
  );
}

/** Never top-up / generic / POC / fan-out supply — tagged, bridge, or owned. */
export function isCallerFollowUpSupplyBlocked(
  account: {
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  },
  email?: string | null,
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  if (isCallerFollowUpSender(account, policy)) return true;
  return isCallerFollowUpOwnedSeat(email ?? account.from_email ?? account.email);
}

export function callerFollowUpCampaignIdsFromSenders(
  accounts: Array<{
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
    campaign_ids?: unknown;
  }>,
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): number[] {
  const ids = new Set<number>();
  for (const account of accounts) {
    if (!isCallerFollowUpSender(account, policy)) continue;
    for (const campaignId of campaignIdsOfAccount(account)) {
      ids.add(campaignId);
    }
  }
  return [...ids];
}

export type CallerFollowUpAttachDecision =
  | { ok: true; reason: string }
  | { ok: false; reason: string };

/**
 * Rule 3 + 9. Only class senders (and warmed owned gabe@ seats
 * targeting that campaign) may sit on a CALLER FOLLOW-UP campaign.
 * Class / owned seats never fan out to any other campaign.
 */
export function callerFollowUpMayAttach(input: {
  email?: string | null;
  account: {
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  };
  campaign:
    | {
        id?: number | null;
        name?: string | null;
      }
    | null
    | undefined;
  warmed?: boolean;
  policy?: CallerFollowUpPolicy;
}): CallerFollowUpAttachDecision {
  const policy = input.policy ?? DEFAULT_CALLER_FOLLOWUP_POLICY;
  const email = normalizeEmail(
    input.email ?? input.account.from_email ?? input.account.email,
  );
  const classCampaign = isCallerFollowUpCampaign(input.campaign, policy);
  const classSender = isCallerFollowUpSender(input.account, policy);
  const ownedTarget = callerFollowUpOwnedTargetCampaignId(email);

  if (classSender) {
    if (!classCampaign) {
      return { ok: false, reason: "class sender never fans out (D242)" };
    }
    return { ok: true, reason: "bridge / tagged class sender on class campaign" };
  }
  if (ownedTarget != null) {
    if (!classCampaign) {
      return { ok: false, reason: "owned gabe@ never fans out (D242)" };
    }
    if (Number(input.campaign?.id) !== ownedTarget) {
      return { ok: false, reason: "owned gabe@ only attaches to its own Gabe Calls campaign" };
    }
    if (!input.warmed) {
      return { ok: false, reason: "owned gabe@ still owes 21-day warmup (D242)" };
    }
    return { ok: true, reason: "owned gabe@ cleared warmup for its campaign" };
  }
  if (classCampaign) {
    return { ok: false, reason: "only class senders sit on CALLER FOLLOW-UP (D242)" };
  }
  return { ok: true, reason: "not a CALLER FOLLOW-UP attach" };
}

/** Signature stays empty. Never apply or converge one. */
export function callerFollowUpDesiredSignature(): string {
  return "";
}

export function callerFollowUpMustKeepEmptySignature(
  account: {
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  },
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return isCallerFollowUpSender(account, policy);
}

export function callerFollowUpMustKeepFromName(
  account: {
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  },
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return isCallerFollowUpSender(account, policy);
}

export function callerFollowUpMustKeepMessagePerDay(
  account: {
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  },
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return isCallerFollowUpSender(account, policy);
}

export function callerFollowUpSkipsRestCycle(
  account: {
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  },
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return isCallerFollowUpSender(account, policy);
}

export function callerFollowUpSkipsStaffingFloor(
  campaign:
    | {
        id?: number | null;
        name?: string | null;
      }
    | null
    | undefined,
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return isCallerFollowUpCampaign(campaign, policy);
}

export function callerFollowUpSkipsEspMix(
  campaign:
    | {
        id?: number | null;
        name?: string | null;
      }
    | null
    | undefined,
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return isCallerFollowUpCampaign(campaign, policy);
}

export function callerFollowUpSkipsRunwayAndTopUpAlerts(
  campaign:
    | {
        id?: number | null;
        name?: string | null;
      }
    | null
    | undefined,
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return isCallerFollowUpCampaign(campaign, policy);
}

export function callerFollowUpSkipsCanonMinGap(
  campaign:
    | {
        id?: number | null;
        name?: string | null;
      }
    | null
    | undefined,
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return isCallerFollowUpCampaign(campaign, policy);
}

export function callerFollowUpScheduleHolds(input: {
  timezone?: string | null;
  daysOfTheWeek?: readonly number[] | null;
  startHour?: number | null;
  endHour?: number | null;
  minTimeBtwEmails?: number | string | null;
}): boolean {
  const tz = String(input.timezone ?? "").trim();
  if (tz && tz !== CALLER_FOLLOWUP_TIMEZONE) return false;
  const days = (input.daysOfTheWeek ?? []).map((d) => Number(d)).filter(Number.isFinite);
  if (days.length) {
    const want = new Set(CALLER_FOLLOWUP_DAYS_OF_WEEK);
    if (days.length !== want.size || days.some((d) => !want.has(d as 1 | 2 | 3 | 4 | 5))) {
      return false;
    }
  }
  if (
    input.startHour != null &&
    Number(input.startHour) !== CALLER_FOLLOWUP_START_HOUR
  ) {
    return false;
  }
  if (
    input.endHour != null &&
    Number(input.endHour) !== CALLER_FOLLOWUP_END_HOUR
  ) {
    return false;
  }
  const gap =
    typeof input.minTimeBtwEmails === "string"
      ? Number(input.minTimeBtwEmails)
      : input.minTimeBtwEmails;
  if (gap != null && Number.isFinite(gap) && gap !== CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS) {
    return false;
  }
  return true;
}

export function isCallerFollowUpCanonGapValue(
  raw: number | string | null | undefined,
): boolean {
  const gap = typeof raw === "string" ? Number(raw) : raw;
  return gap === CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS;
}

export function callerFollowUpForbidsStatusWrite(
  campaign:
    | {
        id?: number | null;
        name?: string | null;
      }
    | null
    | undefined,
  policy: CallerFollowUpPolicy = DEFAULT_CALLER_FOLLOWUP_POLICY,
): boolean {
  return isCallerFollowUpCampaign(campaign, policy);
}

/**
 * Rule 8 — placement / bounce / blacklist still monitor, but a kill
 * or unlink pages Josh and does not act.
 */
export function callerFollowUpMustPageBeforeAct(input: {
  action: "unlink" | "kill" | "start" | "pause" | "rename" | "signature" | "cap";
  account?: {
    tags?: Array<{ tag_name?: unknown; name?: unknown }> | null;
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  };
  campaign?: {
    id?: number | null;
    name?: string | null;
  } | null;
  policy?: CallerFollowUpPolicy;
}): boolean {
  const policy = input.policy ?? DEFAULT_CALLER_FOLLOWUP_POLICY;
  if (input.action === "start" || input.action === "pause") {
    return isCallerFollowUpCampaign(input.campaign, policy);
  }
  if (!input.account) return false;
  return isCallerFollowUpSender(input.account, policy);
}

export function callerFollowUpHumanActionAlert(input: {
  action: string;
  email?: string;
  campaignId?: number;
  campaignName?: string;
  reason?: string;
}): string {
  const who = input.email ? `\`${input.email}\`` : "a CALLER FOLLOW-UP seat";
  const where = input.campaignId
    ? ` on *${input.campaignName ?? "Gabe Calls"}* (#${input.campaignId})`
    : "";
  const why = input.reason ? ` ${input.reason}` : "";
  return [
    `:rotating_light: CALLER FOLLOW-UP needs Josh — automation will not ${input.action} ${who}${where}.${why}`,
    "Warmup stays on. Placement / bounce / blacklist still monitor. Do not unlink, kill, START, or PAUSE from here (D242).",
  ].join("\n");
}

export function callerFollowUpAlertKey(input: {
  action: string;
  email?: string;
  campaignId?: number;
}): string {
  return `caller-followup:${input.action}:${input.email ?? "campaign"}:${input.campaignId ?? 0}`;
}

export function callerFollowUpBridgeShouldBeRemoved(now: Date = new Date()): boolean {
  const ymd = now.toISOString().slice(0, 10);
  return ymd >= CALLER_FOLLOWUP_BRIDGE_REMOVE_BY;
}

export function callerFollowUpBridgeRemovalAlert(): string {
  return [
    `:hourglass_flowing_sand: CALLER FOLLOW-UP bridge seats are due off by ${CALLER_FOLLOWUP_BRIDGE_REMOVE_BY} (D242).`,
    "The 12 owned gabe@ boxes take their place — four per Gabe Calls campaign. Automation will not unlink the gabriel@ seats. Josh to remove.",
    CALLER_FOLLOWUP_BRIDGE_SENDERS.map((row) => `• ${row.email} (SL ${row.id})`).join(
      "\n",
    ),
  ].join("\n");
}
