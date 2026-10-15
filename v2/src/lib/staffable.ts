import {
  AZURE_ENTRA_DOMAINS,
  AZURE_STAFFABLE_WEIGHT,
  CALLER_FOLLOWUP_SENDER_TAG,
  ESP_MIX_FLOOR_RATIO,
  PREWARMED_DOMAINS,
  REGULAR_STAFFABLE_WEIGHT,
  WARMUP_DAYS,
  WARMUP_GATE_EXEMPT_TAG,
  minFloorForClient,
} from "../canon/constants.js";
import { isReleasedCanaryEmail, isCopyCanaryFleetEmail } from "./fleet.js";
import type { SlimAccount, SlimCampaign } from "../types.js";

export type SendType = "google" | "m365" | "azure";
export type EspSlot = "GOOGLE" | "MICROSOFT";

export function tagNames(tags: readonly string[]): string[] {
  return tags.map((t) => t.trim()).filter(Boolean);
}

export function hasTag(tags: readonly string[], want: string): boolean {
  const key = want.trim().toUpperCase();
  return tagNames(tags).some((t) => t.toUpperCase() === key);
}

export function isWarmupGateExempt(tags: readonly string[]): boolean {
  return hasTag(tags, WARMUP_GATE_EXEMPT_TAG);
}

export function isCallerReserved(tags: readonly string[]): boolean {
  return hasTag(tags, CALLER_FOLLOWUP_SENDER_TAG);
}

export function isConnected(account: SlimAccount): boolean {
  return account.smtpOk !== false && account.imapOk !== false;
}

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function classifySendType(account: SlimAccount): SendType {
  const domain = emailDomain(account.email);
  if (AZURE_ENTRA_DOMAINS.has(domain) || hasTag(account.tags, "type:azure")) {
    return "azure";
  }
  if (hasTag(account.tags, "type:google")) return "google";
  if (hasTag(account.tags, "type:m365")) return "m365";
  if (domain.endsWith(".gmail") || /gmail|google/.test(domain)) return "google";
  return "m365";
}

export function mailboxWeight(account: SlimAccount): number {
  return classifySendType(account) === "azure"
    ? AZURE_STAFFABLE_WEIGHT
    : REGULAR_STAFFABLE_WEIGHT;
}

export function mailboxEspSlot(account: SlimAccount): EspSlot {
  return classifySendType(account) === "google" ? "GOOGLE" : "MICROSOFT";
}

export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 86_400_000;
}

/** D1/D50/D243 — later of InboxKit import and Smartlead created_at / warmup start. */
export function warmupClockStartedAt(account: SlimAccount): string | null {
  const stamps = [account.inboxkitWarmedAt, account.warmupStartedAt, account.createdAt]
    .filter((s): s is string => Boolean(s && Number.isFinite(Date.parse(s))));
  if (!stamps.length) return null;
  return stamps.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

export function isPrewarmedDomain(email: string): boolean {
  return (PREWARMED_DOMAINS as readonly string[]).includes(emailDomain(email));
}

export function owesWarmup(
  account: SlimAccount,
  fleetEmails: readonly string[],
  now = Date.now(),
): boolean {
  if (isWarmupGateExempt(account.tags)) return false;
  if (isCopyCanaryFleetEmail(account.email, fleetEmails)) return false;
  if (isReleasedCanaryEmail(account.email)) {
    /* released seats are generics, not canaries — they still owe warmup unless exempt */
  }
  if (isPrewarmedDomain(account.email)) return false;
  const started = warmupClockStartedAt(account);
  const days = started != null ? daysSince(started, now) : null;
  return days == null || days < WARMUP_DAYS;
}

export function podOf(account: SlimAccount): "A" | "B" | null {
  const names = tagNames(account.tags).map((t) => t.toUpperCase());
  const hasA = names.some((n) => n === "POD-A" || n === "POD A");
  const hasB = names.some((n) => n === "POD-B" || n === "POD B");
  if (hasA && !hasB) return "A";
  if (hasB && !hasA) return "B";
  return null;
}

export function onWeekPod(now = new Date()): "A" | "B" {
  const week = isoWeek(now);
  return week % 2 === 0 ? "A" : "B";
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function isActiveStatus(status: string | undefined | null): boolean {
  const s = String(status ?? "").toUpperCase();
  return s === "ACTIVE" || s === "START";
}

export function isStaffableSender(
  account: SlimAccount,
  opts: {
    resting?: boolean;
    copyCanary?: boolean;
    lapsed?: boolean;
    fleetEmails?: readonly string[];
    now?: number;
    requireOnWeekPod?: boolean;
    onWeek?: "A" | "B";
  } = {},
): boolean {
  if (!isConnected(account)) return false;
  if (opts.resting) return false;
  if (opts.copyCanary || isCopyCanaryFleetEmail(account.email, opts.fleetEmails ?? [])) {
    return false;
  }
  if (opts.lapsed) return false;
  if (account.messagePerDay !== null && account.messagePerDay <= 0) return false;
  if (isCallerReserved(account.tags)) return false;
  if (owesWarmup(account, opts.fleetEmails ?? [], opts.now ?? Date.now())) return false;
  if (opts.requireOnWeekPod) {
    const pod = podOf(account);
    const week = opts.onWeek ?? onWeekPod();
    if (pod && pod !== week) return false;
  }
  return true;
}

export function weightedStaffableOnCampaign(
  campaign: SlimCampaign,
  accounts: SlimAccount[],
  opts: { fleetEmails?: readonly string[]; now?: number; onWeek?: "A" | "B" } = {},
): number {
  const week = opts.onWeek ?? onWeekPod();
  let total = 0;
  for (const account of accounts) {
    if (!account.campaignIds.includes(campaign.id)) continue;
    if (
      !isStaffableSender(account, {
        fleetEmails: opts.fleetEmails,
        now: opts.now,
        requireOnWeekPod: true,
        onWeek: week,
      })
    ) {
      continue;
    }
    total += mailboxWeight(account);
  }
  return Math.round(total * 10) / 10;
}

export function understaffed(
  campaign: SlimCampaign,
  accounts: SlimAccount[],
  opts?: { fleetEmails?: readonly string[]; now?: number },
): number | null {
  if (!isActiveStatus(campaign.status)) return null;
  const floor = minFloorForClient(campaign.clientId);
  const have = weightedStaffableOnCampaign(campaign, accounts, opts);
  if (have + 1e-6 >= floor) return null;
  return Math.ceil(floor - have - 1e-6);
}

/**
 * D203/D233/D263 — when both ESPs exist, neither may sit under ~1/3 of
 * *that POD's real seat count*. Do not pad with max(n, 40). Azure is Microsoft at 0.1.
 */
export function espMixBroken(
  campaign: SlimCampaign,
  accounts: SlimAccount[],
  opts?: { fleetEmails?: readonly string[]; now?: number },
): boolean {
  if (!isActiveStatus(campaign.status)) return false;
  const week = onWeekPod();
  const options = opts ?? {};
  const onPod: SlimAccount[] = [];
  for (const account of accounts) {
    if (!account.campaignIds.includes(campaign.id)) continue;
    if (
      !isStaffableSender(account, {
        fleetEmails: options.fleetEmails,
        now: options.now,
        requireOnWeekPod: true,
        onWeek: week,
      })
    ) {
      continue;
    }
    onPod.push(account);
  }
  let google = 0;
  let microsoft = 0;
  for (const account of onPod) {
    const w = mailboxWeight(account);
    if (mailboxEspSlot(account) === "GOOGLE") google += w;
    else microsoft += w;
  }
  const total = google + microsoft;
  if (google === 0 || microsoft === 0) return false;
  const floor = total * ESP_MIX_FLOOR_RATIO;
  return google + 1e-6 < floor || microsoft + 1e-6 < floor;
}

export function azureWouldReplaceGoogle(
  leaving: SlimAccount,
  incoming: SlimAccount,
): boolean {
  return mailboxEspSlot(leaving) === "GOOGLE" && mailboxEspSlot(incoming) !== "GOOGLE";
}

export function displayShortfall(weighted: number): number {
  return Math.ceil(Math.round(weighted * 1e6) / 1e6);
}

export function displayStaffable(weighted: number): number {
  return Math.floor(Math.round(weighted * 1e6) / 1e6);
}
