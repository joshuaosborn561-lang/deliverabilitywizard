import type { AppConfig } from "../config.js";
import {
  CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS,
  CALLER_FOLLOWUP_SENDER_TAG,
  INSIGHT_CLIENT_ID,
  MIN_TIME_BTW_EMAILS,
  POC_TAG,
  SALESGLIDER_CLIENT_ID,
  STEP2_DELAY_DAYS,
} from "../canon/constants.js";
import { isCopyCanaryFleetEmail } from "../lib/fleet.js";
import { genericIdleFindings } from "../lib/genericIdle.js";
import { staffingInventoryReady } from "../lib/inventory.js";
import { clientBrandFromRecord, clientBrandList, signatureMismatch } from "../lib/signature.js";
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
import {
  canStaffInsightCampaign,
  insightExemptFromSenderTopUp,
  isInsightJoshAllowedSender,
  isInsightJoshOnlyCampaign,
} from "../lib/insight.js";
import {
  isCallerFollowUpCampaign,
  isGabeFollowUpCampaign,
  isPocEngagementClient,
  seatTargetForCampaign,
  shouldStaffPocCampaign,
} from "../lib/poc.js";
import {
  espMatchingViolation,
  htmlBodyViolation,
  plainTextSettingsPayload,
  plainTextSettingsViolation,
  sendWindowViolation,
  sendCanonLockDrift,
  sendCanonLockSchedulePayload,
  standingSchedulePayload,
} from "../lib/campaignCanon.js";
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
  const allBrands = clientBrandList(opts.book.clients ?? []);
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
    if (isCallerFollowUpCampaign(campaign) || isGabeFollowUpCampaign(campaign)) continue;
    const poc = isPocEngagementClient({
      clientId: campaign.clientId,
      name: campaign.name,
    });
    if (poc && !shouldStaffPocCampaign(campaign)) continue;
    if (!poc && !isActiveStatus(campaign.status)) continue;

    const members = opts.book.accounts.filter((a) => a.campaignIds.includes(campaign.id));
    const brand = clients.get(campaign.clientId ?? -1);
    const floor = seatTargetForCampaign(campaign);
    const staffingReady = staffingInventoryReady(opts.book);

    if (staffingReady && !insightExemptFromSenderTopUp(campaign)) {
      const short = understaffed(campaign, opts.book.accounts, {
        fleetEmails: opts.fleetEmails,
        now: now.getTime(),
        floor,
        ignorePodWeek: poc,
        living: poc ? true : isActiveStatus(campaign.status),
      });
      if (short != null) {
        findings.push({
          kind: "understaffed",
          campaignId: campaign.id,
          detail: `${campaign.name} ${poc ? "POC" : "on-week"} staffable short ${short} (floor ${floor})`,
        });
      }
      if (
        !poc &&
        espMixBroken(campaign, opts.book.accounts, { fleetEmails: opts.fleetEmails, now: now.getTime() })
      ) {
        findings.push({
          kind: "esp_mix",
          campaignId: campaign.id,
          detail: `${campaign.name} on-week ESP mix under 1/3 of real POD size`,
        });
      }
      if (!poc && !insightExemptFromSenderTopUp(campaign)) {
        findings.push(
          ...genericIdleFindings({
            campaign,
            accounts: opts.book.accounts,
            floor,
            week,
            fleetEmails: opts.fleetEmails,
            extraGenericDomains: opts.config.extraGenericDomains,
            now: now.getTime(),
          }),
        );
      }
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

    const checkSettings = poc ? isActiveStatus(campaign.status) || campaign.status.toUpperCase() === "START" : true;
    if (checkSettings || isActiveStatus(campaign.status) || campaign.status.toUpperCase() === "DRAFTED") {
      const livingForSettings =
        isActiveStatus(campaign.status) ||
        ["DRAFT", "DRAFTED", "START"].includes(campaign.status.toUpperCase());
      if (livingForSettings) {
        await intendCampaignCanon({
          campaign,
          sequences: (opts.sequences ?? []).filter((s) => s.campaignId === campaign.id),
          gate: opts.gate,
          findings,
          intended,
        });
      }
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

      if (isInsightJoshOnlyCampaign(campaign) && !isInsightJoshAllowedSender(account)) {
        findings.push({
          kind: "insight_non_josh_sender",
          campaignId: campaign.id,
          accountId: account.id,
          email: account.email,
          detail: `${account.email} is not a Josh Osborn mailbox on a salesglider* or Insight domain (D282)`,
        });
      }

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
          ignorePodWeek: poc,
        });
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

      const sig = signatureMismatch({
        fromName: account.fromName,
        signature: account.signature,
        clientBrand: brand,
        otherClientBrands: allBrands,
        tags: account.tags,
      });
      if (sig) {
        findings.push({
          kind: "mailbox_sig",
          campaignId: campaign.id,
          accountId: account.id,
          email: account.email,
          detail: sig.reason,
        });
        intended.push(
          (
            await opts.gate.intend({
              kind: "signature_write",
              campaignId: campaign.id,
              accountId: account.id,
              email: account.email,
              payload: { reason: sig.reason, signature: sig.desired },
              run: async () => undefined,
            })
          ).action,
        );
      }

      if (!poc) {
        const pod = podOf(account);
        if (pod && pod !== week && isStaffableSender(account, { fleetEmails: opts.fleetEmails })) {
          const after = weightedStaffableOnCampaign(campaign, opts.book.accounts, {
            fleetEmails: opts.fleetEmails,
            now: now.getTime(),
          });
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
    }

    if (staffingReady && !insightExemptFromSenderTopUp(campaign)) {
      await fillFloor({
        campaign,
        book: opts.book,
        fleetEmails: opts.fleetEmails,
        gate: opts.gate,
        store: opts.store,
        intended,
        week,
        now: now.getTime(),
        skipIds: heldIds,
        poc,
        floor,
      });
    }
  }

  // D304 — LOCKED send canon on every non-STOPPED campaign (PAUSED,
  // DRAFTED and COMPLETED too). Intents only; WRITE_ENABLED gates writes.
  // Skip what the per-campaign canon above already intended.
  for (const campaign of opts.book.campaigns) {
    const drift = sendCanonLockDrift(campaign);
    if (!drift) continue;
    const already = new Set(
      findings.filter((f) => f.campaignId === campaign.id).map((f) => f.kind),
    );
    const espOff = drift.espOff && !already.has("esp_matching");
    const gapOff = drift.gapOff && !already.has("send_window");
    if (!espOff && !gapOff) continue;
    const parts: string[] = [];
    if (espOff) parts.push("enable_ai_esp_matching off, want on");
    if (gapOff) parts.push(`gap ${campaign.minTimeBtwnEmails}, want ${MIN_TIME_BTW_EMAILS}`);
    findings.push({ kind: "send_canon_lock", campaignId: campaign.id, detail: `${parts.join("; ")} (D304)` });
    if (espOff) {
      intended.push(
        (
          await opts.gate.intend({
            kind: "settings_write",
            campaignId: campaign.id,
            payload: { reason: "send_canon_lock", enable_ai_esp_matching: true },
            run: async () => undefined,
          })
        ).action,
      );
    }
    const schedule = gapOff ? sendCanonLockSchedulePayload(campaign) : null;
    if (schedule) {
      intended.push(
        (
          await opts.gate.intend({
            kind: "schedule_write",
            campaignId: campaign.id,
            payload: { reason: "send_canon_lock", schedule },
            run: async () => undefined,
          })
        ).action,
      );
    }
  }

  if (opts.runQa !== false) {
    try {
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
    } catch {
      /* staffing findings still ship if QA ledger write fails */
    }
  }

  return { findings, intended };
}

async function intendCampaignCanon(opts: {
  campaign: SlimCampaign;
  sequences: SequenceSample[];
  gate: WriteGate;
  findings: Finding[];
  intended: IntendedAction[];
}): Promise<void> {
  const { campaign } = opts;
  const esp = espMatchingViolation(campaign);
  if (esp) {
    opts.findings.push({ kind: "esp_matching", campaignId: campaign.id, detail: esp });
    opts.intended.push(
      (
        await opts.gate.intend({
          kind: "settings_write",
          campaignId: campaign.id,
          payload: {
            reason: "esp_matching",
            enable_ai_esp_matching: true,
            ...plainTextSettingsPayload(),
          },
          run: async () => undefined,
        })
      ).action,
    );
  }

  const plain = plainTextSettingsViolation(campaign);
  if (plain) {
    opts.findings.push({ kind: "plain_text", campaignId: campaign.id, detail: plain });
    if (!esp) {
      opts.intended.push(
        (
          await opts.gate.intend({
            kind: "settings_write",
            campaignId: campaign.id,
            payload: { reason: "plain_text", ...plainTextSettingsPayload() },
            run: async () => undefined,
          })
        ).action,
      );
    }
  }

  const html = htmlBodyViolation(opts.sequences);
  if (html) {
    opts.findings.push({ kind: "html_body", campaignId: campaign.id, detail: html });
    opts.intended.push(
      (
        await opts.gate.intend({
          kind: "sequence_write",
          campaignId: campaign.id,
          payload: { reason: "plain_text_html", stripHtml: true },
          run: async () => undefined,
        })
      ).action,
    );
  }

  const window = sendWindowViolation(campaign);
  if (window) {
    opts.findings.push({ kind: "send_window", campaignId: campaign.id, detail: window });
    opts.intended.push(
      (
        await opts.gate.intend({
          kind: "schedule_write",
          campaignId: campaign.id,
          payload: { reason: "send_window", schedule: standingSchedulePayload() },
          run: async () => undefined,
        })
      ).action,
    );
  }
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

/** D298: brand comes from the Smartlead client record only, never a campaign name. */
export function clientsOf(book: InventoryBook): Map<number, string> {
  const map = new Map<number, string>();
  for (const c of book.clients ?? []) {
    const brand = clientBrandFromRecord(c);
    if (brand) map.set(c.id, brand);
  }
  return map;
}

async function fillFloor(opts: {
  campaign: SlimCampaign;
  book: InventoryBook;
  fleetEmails: readonly string[];
  gate: WriteGate;
  store: V2Store;
  intended: IntendedAction[];
  week: "A" | "B";
  now: number;
  skipIds?: Set<number>;
  poc: boolean;
  floor: number;
}): Promise<void> {
  const short = understaffed(opts.campaign, opts.book.accounts, {
    fleetEmails: opts.fleetEmails,
    now: opts.now,
    floor: opts.floor,
    ignorePodWeek: opts.poc,
    living: true,
  });
  if (short == null) return;
  if (!staffingInventoryReady(opts.book)) return;
  const already = await opts.store.countPendingIntents(
    "attach",
    opts.campaign.id,
    opts.poc ? "poc_fill" : "min40_floor",
  );
  let need = short - already;
  if (need <= 0) return;
  const used = new Set(
    opts.book.accounts.filter((a) => a.campaignIds.includes(opts.campaign.id)).map((a) => a.id),
  );
  const candidates = opts.book.accounts.filter((account) => {
    if (used.has(account.id)) return false;
    if (opts.skipIds?.has(account.id)) return false;
    if (isCopyCanaryFleetEmail(account.email, opts.fleetEmails)) return false;
    if (isCallerReserved(account.tags)) return false;
    if (!isStaffableSender(account, { fleetEmails: opts.fleetEmails, now: opts.now })) return false;
    if (!canStaffInsightCampaign(account, opts.campaign)) return false;
    if (
      account.clientId != null &&
      opts.campaign.clientId != null &&
      account.clientId !== opts.campaign.clientId
    ) {
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
    const payload = opts.poc
      ? { reason: "poc_fill", floor: opts.floor, tag: POC_TAG, noPod: true }
      : { reason: "min40_floor", floor: opts.floor, week: opts.week };
    const existing = await opts.store.findPendingIntent({
      kind: "attach",
      campaignId: opts.campaign.id,
      accountId: account.id,
      email: account.email,
      payload,
    });
    if (existing) continue;
    const result = await opts.gate.intend({
      kind: "attach",
      campaignId: opts.campaign.id,
      accountId: account.id,
      email: account.email,
      payload,
      run: async () => undefined,
    });
    opts.intended.push(result.action);
    need -= 1;
  }
}

export const STEP2_DAYS = STEP2_DELAY_DAYS;
export const CALLER_GAP = CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS;
