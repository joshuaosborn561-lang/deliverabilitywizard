import {
  AZURE_CAMPAIGN_PER_DAY,
  GOOGLE_CAMPAIGN_PER_DAY,
  M365_CAMPAIGN_PER_DAY,
  TERL_HOLD_MS,
  minFloorForClient,
} from "../canon/constants.js";
import { classifyBounceReason } from "./bounce.js";
import {
  classifySendType,
  isCallerReserved,
  isStaffableSender,
  onWeekPod,
  podOf,
  weightedStaffableOnCampaign,
} from "./staffable.js";
import type { WriteGate } from "../shadow.js";
import type { V2Store } from "../store.js";
import type {
  Finding,
  IntendedAction,
  InventoryBook,
  SeatHold,
  SlimAccount,
  SlimCampaign,
  TerlSubstitution,
} from "../types.js";

export interface BounceEvent {
  accountId: number;
  email: string;
  smtp: string;
}

export function tenantOfEmail(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function typeCapPerDay(account: SlimAccount): number {
  const type = classifySendType(account);
  if (type === "azure") return AZURE_CAMPAIGN_PER_DAY;
  if (type === "google") return GOOGLE_CAMPAIGN_PER_DAY;
  return M365_CAMPAIGN_PER_DAY;
}

export function holdIsOpen(hold: SeatHold, now = Date.now()): boolean {
  if (!hold.expiresAt) return true;
  const t = Date.parse(hold.expiresAt);
  return Number.isFinite(t) && now < t;
}

export function writersMustSkipHold(hold: SeatHold, now = Date.now()): boolean {
  return holdIsOpen(hold, now);
}

/**
 * D212/D213/D218/D219 — 5.7.233 is a 24h mpd-0 hold + same-client sub.
 * 5.1.8 is a no-restore hold. Intended only in shadow.
 */
export async function runTerlTick(opts: {
  book: InventoryBook;
  events: BounceEvent[];
  gate: WriteGate;
  store: V2Store;
  fleetEmails?: readonly string[];
  now?: Date;
}): Promise<{ findings: Finding[]; intended: IntendedAction[] }> {
  const now = opts.now ?? new Date();
  const findings: Finding[] = [];
  const intended: IntendedAction[] = [];
  const fleetEmails = opts.fleetEmails ?? [];
  const existingHolds = await opts.store.listHolds();
  const holdById = new Map(existingHolds.map((h) => [h.accountId, h]));
  const openSubs = (await opts.store.listTerlSubs()).filter((s) => !s.restoredAt);

  for (const event of opts.events) {
    const klass = classifyBounceReason(event.smtp);
    const account = opts.book.accounts.find((a) => a.id === event.accountId);
    if (!account) continue;
    if (isCallerReserved(account.tags)) continue;
    const tenant = tenantOfEmail(event.email || account.email);

    if (klass === "tenant_outbound_block") {
      const peers = opts.book.accounts.filter((a) => tenantOfEmail(a.email) === tenant);
      for (const peer of peers) {
        const hold: SeatHold = {
          accountId: peer.id,
          email: peer.email,
          reason: "tenant_outbound_block",
          evidence: event.smtp,
          expiresAt: null,
          createdAt: now.toISOString(),
        };
        await opts.store.upsertHold(hold);
        holdById.set(peer.id, hold);
        intended.push(
          (
            await opts.gate.intend({
              kind: "hold",
              accountId: peer.id,
              email: peer.email,
              payload: { reason: "tenant_outbound_block", evidence: event.smtp },
              run: async () => undefined,
            })
          ).action,
        );
        intended.push(
          (
            await opts.gate.intend({
              kind: "mpd_write",
              accountId: peer.id,
              email: peer.email,
              payload: { maxEmailPerDay: 0, reason: "5.1.8_no_restore" },
              run: async () => undefined,
            })
          ).action,
        );
      }
      findings.push({
        kind: "tenant_outbound_block",
        accountId: account.id,
        email: account.email,
        detail: `${tenant} 5.1.8 outbound block — hold with no automatic restore`,
      });
      continue;
    }

    if (klass !== "tenant_rate_limit") continue;

    const peers = opts.book.accounts.filter((a) => tenantOfEmail(a.email) === tenant);
    const until = new Date(now.getTime() + TERL_HOLD_MS).toISOString();
    for (const peer of peers) {
      const hold: SeatHold = {
        accountId: peer.id,
        email: peer.email,
        reason: "tenant_rate_limit",
        evidence: event.smtp,
        expiresAt: until,
        createdAt: now.toISOString(),
      };
      await opts.store.upsertHold(hold);
      holdById.set(peer.id, hold);
      intended.push(
        (
          await opts.gate.intend({
            kind: "mpd_write",
            accountId: peer.id,
            email: peer.email,
            payload: { maxEmailPerDay: 0, reason: "5.7.233_24h", restoreAfter: until },
            run: async () => undefined,
          })
        ).action,
      );
    }
    findings.push({
      kind: "tenant_rate_limit",
      accountId: account.id,
      email: account.email,
      detail: `${tenant} 5.7.233 — 24h hold, same-client substitute`,
    });

    const week = onWeekPod(now);
    const campaigns = opts.book.campaigns.filter(
      (c) =>
        String(c.status).toUpperCase() === "ACTIVE" &&
        account.campaignIds.includes(c.id),
    );
    for (const campaign of campaigns) {
      if (openSubs.some((s) => s.campaignId === campaign.id && s.stoppedAccountId === account.id)) {
        continue;
      }
      const sub = pickSameClientSubstitute({
        campaign,
        book: opts.book,
        stopped: account,
        fleetEmails,
        week,
        now: now.getTime(),
        holds: holdById,
      });
      const row: TerlSubstitution = {
        campaignId: campaign.id,
        stoppedAccountId: account.id,
        stoppedEmail: account.email,
        substituteAccountId: sub?.id ?? null,
        substituteEmail: sub?.email ?? null,
        clientId: campaign.clientId,
        tenant,
        stoppedAt: now.toISOString(),
        restoreAfter: until,
        restoredAt: null,
        noSubstitute: !sub,
      };
      await opts.store.upsertTerlSub(row);
      if (sub) {
        intended.push(
          (
            await opts.gate.intend({
              kind: "attach",
              campaignId: campaign.id,
              accountId: sub.id,
              email: sub.email,
              payload: { reason: "terrl_substitute", stopped: account.email },
              run: async () => undefined,
            })
          ).action,
        );
      } else {
        findings.push({
          kind: "terrl_no_substitute",
          campaignId: campaign.id,
          detail: `${campaign.name} no substitute available, at 39 sending`,
        });
      }
    }
  }

  for (const sub of openSubs) {
    if (Date.parse(sub.restoreAfter) > now.getTime()) continue;
    const stopped = opts.book.accounts.find((a) => a.id === sub.stoppedAccountId);
    if (stopped) {
      intended.push(
        (
          await opts.gate.intend({
            kind: "mpd_write",
            accountId: stopped.id,
            email: stopped.email,
            payload: {
              maxEmailPerDay: typeCapPerDay(stopped),
              reason: "terrl_restore",
            },
            run: async () => undefined,
          })
        ).action,
      );
    }
    if (sub.substituteAccountId && sub.substituteEmail) {
      intended.push(
        (
          await opts.gate.intend({
            kind: "detach",
            campaignId: sub.campaignId,
            accountId: sub.substituteAccountId,
            email: sub.substituteEmail,
            payload: { reason: "terrl_sub_release" },
            run: async () => undefined,
          })
        ).action,
      );
    }
    await opts.store.upsertTerlSub({ ...sub, restoredAt: now.toISOString() });
    const hold = holdById.get(sub.stoppedAccountId);
    if (hold && hold.reason === "tenant_rate_limit") {
      await opts.store.upsertHold({ ...hold, expiresAt: now.toISOString() });
    }
  }

  return { findings, intended };
}

function pickSameClientSubstitute(opts: {
  campaign: SlimCampaign;
  book: InventoryBook;
  stopped: SlimAccount;
  fleetEmails: readonly string[];
  week: "A" | "B";
  now: number;
  holds: Map<number, SeatHold>;
}): SlimAccount | undefined {
  const used = new Set(
    opts.book.accounts.filter((a) => a.campaignIds.includes(opts.campaign.id)).map((a) => a.id),
  );
  const staffable = weightedStaffableOnCampaign(opts.campaign, opts.book.accounts, {
    fleetEmails: opts.fleetEmails,
    now: opts.now,
  });
  const floor = minFloorForClient(opts.campaign.clientId);
  if (staffable + 1e-6 >= floor + 1) return undefined;
  return opts.book.accounts.find((account) => {
    if (used.has(account.id)) return false;
    if (account.id === opts.stopped.id) return false;
    if (isCallerReserved(account.tags)) return false;
    const hold = opts.holds.get(account.id);
    if (hold && writersMustSkipHold(hold, opts.now)) return false;
    if (!isStaffableSender(account, { fleetEmails: opts.fleetEmails, now: opts.now })) {
      return false;
    }
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
}
