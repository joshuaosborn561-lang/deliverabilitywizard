import type { AppConfig } from "../config.js";
import {
  CALLER_FOLLOWUP_CAMPAIGN_IDS,
  CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS,
  CALLER_FOLLOWUP_NAME_PREFIX,
  CALLER_FOLLOWUP_SENDER_TAG,
  INSIGHT_CLIENT_ID,
  MIN_TIME_BTW_EMAILS,
  SALESGLIDER_CLIENT_ID,
  STEP2_DELAY_DAYS,
  minFloorForClient,
} from "../canon/constants.js";
import { isCopyCanaryFleetEmail } from "../lib/fleet.js";
import { mailboxSignatureMismatch } from "../lib/signature.js";
import {
  azureWouldReplaceGoogle,
  espMixBroken,
  hasTag,
  isActiveStatus,
  isCallerReserved,
  isStaffableSender,
  onWeekPod,
  owesWarmup,
  podOf,
  understaffed,
  weightedStaffableOnCampaign,
} from "../lib/staffable.js";
import type { WriteGate } from "../shadow.js";
import type { V2Store } from "../store.js";
import { runReconnectTick } from "../lib/reconnect.js";
import { runTerlTick, writersMustSkipHold, type BounceEvent } from "../lib/terl.js";
import { runQaTick } from "./qa.js";
import type {
  Finding,
  IntendedAction,
  InventoryBook,
  LeadSample,
  SequenceSample,
  SlimAccount,
  SlimCampaign,
} from "../types.js";

export interface StaffTickResult {
  findings: Finding[];
  intended: IntendedAction[];
}

export async function runStaffTick(opts: {
  book: InventoryBook;
  fleetEmails: readonly string[];
  gate: WriteGate;
  store: V2Store;
  config: AppConfig;
  now?: Date;
  bounceEvents?: BounceEvent[];
  sequences?: SequenceSample[];
  leads?: LeadSample[];
  runQa?: boolean;
}): Promise<StaffTickResult> {
  const now = opts.now ?? new Date();
  const findings: Finding[] = [];
  const intended: IntendedAction[] = [];
  const week = onWeekPod(now);
  const clients = clientsOf(opts.book);
  const holds = await opts.store.listHolds();
  const heldIds = new Set(
    holds.filter((h) => writersMustSkipHold(h, now.getTime())).map((h) => h.accountId),
  );

  const reconnect = await runReconnectTick({ accounts: opts.book.accounts, gate: opts.gate });
  findings.push(...reconnect.findings);
  intended.push(...reconnect.intended);

  const terl = await runTerlTick({
    book: opts.book,
    events: opts.bounceEvents ?? [],
    gate: opts.gate,
    store: opts.store,
    fleetEmails: opts.fleetEmails,
    now,
  });
  findings.push(...terl.findings);
  intended.push(...terl.intended);

  for (const campaign of opts.book.campaigns) {
    if (isCallerFollowUpCampaign(campaign)) continue;
    if (!isActiveStatus(campaign.status)) continue;

    const members = opts.book.accounts.filter((a) => a.campaignIds.includes(campaign.id));
    const brand = clients.get(campaign.clientId ?? -1) ?? campaign.name.split("|")[0]?.trim();

    const short = understaffed(campaign, opts.book.accounts, {
      fleetEmails: opts.fleetEmails,
      now: now.getTime(),
    });
    if (short != null) {
      findings.push({
        kind: "understaffed",
        campaignId: campaign.id,
        detail: `${campaign.name} on-week staffable short ${short} (floor ${minFloorForClient(campaign.clientId)})`,
      });
    }
    if (espMixBroken(campaign, opts.book.accounts, { fleetEmails: opts.fleetEmails, now: now.getTime() })) {
      findings.push({
        kind: "esp_mix",
        campaignId: campaign.id,
        detail: `${campaign.name} on-week ESP mix under 1/3 of real POD size`,
      });
    }

    if (
      campaign.minTimeBtwnEmails != null &&
      campaign.minTimeBtwnEmails < MIN_TIME_BTW_EMAILS &&
      !isCallerFollowUpCampaign(campaign)
    ) {
      findings.push({
        kind: "mailbox_gap",
        campaignId: campaign.id,
        detail: `min_time_btwn_emails is ${campaign.minTimeBtwnEmails}, want ${MIN_TIME_BTW_EMAILS}`,
      });
    }

    for (const account of members) {
      if (isCopyCanaryFleetEmail(account.email, opts.fleetEmails)) {
        findings.push({
          kind: "canary_on_live",
          campaignId: campaign.id,
          accountId: account.id,
          email: account.email,
          detail: "living canary linked to a live campaign",
        });
        intended.push(
          (
            await opts.gate.intend({
              kind: "detach",
              campaignId: campaign.id,
              accountId: account.id,
              email: account.email,
              payload: { reason: "canary_on_live" },
              run: async () => undefined,
            })
          ).action,
        );
        continue;
      }

      if (isCallerReserved(account.tags)) continue;
      if (heldIds.has(account.id)) continue;

      if (owesWarmup(account, opts.fleetEmails, now.getTime()) && isActiveStatus(campaign.status)) {
        findings.push({
          kind: "under_warmed",
          campaignId: campaign.id,
          accountId: account.id,
          email: account.email,
          detail: `${account.email} owes 21-day warmup`,
        });
        intended.push(
          (
            await opts.gate.intend({
              kind: "detach",
              campaignId: campaign.id,
              accountId: account.id,
              email: account.email,
              payload: { reason: "warmup_gate" },
              run: async () => undefined,
            })
          ).action,
        );
      }

      const foreign = foreignClient(account, campaign);
      if (foreign) {
        findings.push({
          kind: "cross_client_membership",
          campaignId: campaign.id,
          accountId: account.id,
          email: account.email,
          detail: `${account.email} client ${account.clientId} on campaign client ${campaign.clientId}`,
        });
        const staffable = weightedStaffableOnCampaign(campaign, opts.book.accounts, {
          fleetEmails: opts.fleetEmails,
          now: now.getTime(),
        });
        const floor = minFloorForClient(campaign.clientId);
        if (staffable - 1 + 1e-6 >= floor) {
          intended.push(
            (
              await opts.gate.intend({
                kind: "detach",
                campaignId: campaign.id,
                accountId: account.id,
                email: account.email,
                payload: { reason: "foreign_client" },
                run: async () => undefined,
              })
            ).action,
          );
        }
      }

      const sig = mailboxSignatureMismatch({
        fromName: account.fromName,
        signature: account.signature,
        clientBrand: brand,
        tags: account.tags,
      });
      if (sig) {
        findings.push({
          kind: "mailbox_sig",
          campaignId: campaign.id,
          accountId: account.id,
          email: account.email,
          detail: sig,
        });
        intended.push(
          (
            await opts.gate.intend({
              kind: "signature_write",
              campaignId: campaign.id,
              accountId: account.id,
              email: account.email,
              payload: { reason: sig },
              run: async () => undefined,
            })
          ).action,
        );
      }

      const pod = podOf(account);
      if (pod && pod !== week && isStaffableSender(account, { fleetEmails: opts.fleetEmails })) {
        const after = weightedStaffableOnCampaign(campaign, opts.book.accounts, {
          fleetEmails: opts.fleetEmails,
          now: now.getTime(),
        });
        const floor = minFloorForClient(campaign.clientId);
        if (after - 1 + 1e-6 >= floor) {
          intended.push(
            (
              await opts.gate.intend({
                kind: "detach",
                campaignId: campaign.id,
                accountId: account.id,
                email: account.email,
                payload: { reason: "off_week_rest", pod, week },
                run: async () => undefined,
              })
            ).action,
          );
        }
      }
    }

    await fillFloor({
      campaign,
      book: opts.book,
      fleetEmails: opts.fleetEmails,
      gate: opts.gate,
      intended,
      week,
      now: now.getTime(),
      skipIds: heldIds,
    });
  }

  if (opts.runQa !== false) {
    const qa = await runQaTick({
      book: opts.book,
      role: "staff",
      trigger: "scheduled",
      store: opts.store,
      gate: opts.gate,
      sequences: opts.sequences,
      leads: opts.leads,
      now,
    });
    findings.push(...qa.findings);
    intended.push(...qa.intended);
  }

  return { findings, intended };
}

function isCallerFollowUpCampaign(campaign: SlimCampaign): boolean {
  if ((CALLER_FOLLOWUP_CAMPAIGN_IDS as readonly number[]).includes(campaign.id)) return true;
  return campaign.name.startsWith(CALLER_FOLLOWUP_NAME_PREFIX);
}

function foreignClient(account: SlimAccount, campaign: SlimCampaign): boolean {
  if (account.clientId == null || campaign.clientId == null) return false;
  if (hasTag(account.tags, CALLER_FOLLOWUP_SENDER_TAG)) return false;
  if (account.clientId === campaign.clientId) return false;
  if (
    (account.clientId === INSIGHT_CLIENT_ID && campaign.clientId === SALESGLIDER_CLIENT_ID) ||
    (account.clientId === SALESGLIDER_CLIENT_ID && campaign.clientId === INSIGHT_CLIENT_ID)
  ) {
    return true;
  }
  return true;
}

function clientsOf(book: InventoryBook): Map<number, string> {
  const map = new Map<number, string>();
  for (const c of book.campaigns) {
    if (c.clientId != null && !map.has(c.clientId)) {
      map.set(c.clientId, c.name.split("|")[0]?.trim() ?? String(c.clientId));
    }
  }
  return map;
}

async function fillFloor(opts: {
  campaign: SlimCampaign;
  book: InventoryBook;
  fleetEmails: readonly string[];
  gate: WriteGate;
  intended: IntendedAction[];
  week: "A" | "B";
  now: number;
  skipIds?: Set<number>;
}): Promise<void> {
  const short = understaffed(opts.campaign, opts.book.accounts, {
    fleetEmails: opts.fleetEmails,
    now: opts.now,
  });
  if (short == null) return;
  const floor = minFloorForClient(opts.campaign.clientId);
  let need = short;
  const used = new Set(
    opts.book.accounts.filter((a) => a.campaignIds.includes(opts.campaign.id)).map((a) => a.id),
  );
  const candidates = opts.book.accounts.filter((account) => {
    if (used.has(account.id)) return false;
    if (opts.skipIds?.has(account.id)) return false;
    if (isCopyCanaryFleetEmail(account.email, opts.fleetEmails)) return false;
    if (isCallerReserved(account.tags)) return false;
    if (!isStaffableSender(account, { fleetEmails: opts.fleetEmails, now: opts.now })) return false;
    if (account.clientId != null && opts.campaign.clientId != null && account.clientId !== opts.campaign.clientId) {
      return false;
    }
    const pod = podOf(account);
    if (pod && pod !== opts.week) return false;
    return true;
  });
  for (const account of candidates) {
    if (need <= 0) break;
    const googleLeaving = opts.book.accounts.find(
      (a) => a.campaignIds.includes(opts.campaign.id) && !isStaffableSender(a, { fleetEmails: opts.fleetEmails }),
    );
    if (googleLeaving && azureWouldReplaceGoogle(googleLeaving, account)) continue;
    const result = await opts.gate.intend({
      kind: "attach",
      campaignId: opts.campaign.id,
      accountId: account.id,
      email: account.email,
      payload: { reason: "min40_floor", floor, week: opts.week },
      run: async () => undefined,
    });
    opts.intended.push(result.action);
    need -= 1;
  }
}

export const STEP2_DAYS = STEP2_DELAY_DAYS;
export const CALLER_GAP = CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS;
