/**
 * D219 — apply / restore Microsoft 550 5.7.233 holds.
 *
 * Stop: mpd=0, stay linked, POD tag untouched. One same-client warm
 * generic temporarily links on the on-week campaign (41 linked / 40
 * sending). Restore after 24h: type cap back, unlink the substitute.
 * Never retag named seats. Never borrow another client's generic.
 */

import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { isGenericMailbox } from "../lib/clientInbox.js";
import { resolveDedicatedGenericClientId } from "../lib/dedicatedGeneric.js";
import { chicagoWallClock, canonOpsIdleReason } from "../lib/canonOpsHours.js";
import { sleep } from "../lib/http.js";
import { onWeekCohort } from "../lib/restCohort.js";
import { mailboxMessagePerDayTarget } from "../lib/sendCeiling.js";
import { isOutlookMailboxType } from "../lib/sendCeiling.js";
import { buildPoolSignature, parsePersonName } from "../lib/poolSignature.js";
import {
  terlEodDigestText,
  terlHeldUntil,
  terlSubstitutionKey,
  type TerlEodShortage,
  type TerlPausedInbox,
  type TerlSubstitution,
} from "../lib/tenantTerlHold.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { senderIsAttachBlocked } from "../lib/attachBlock.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { owesWarmup } from "./warmupGate.js";
import { isExcluded } from "./campaignTopUp.js";
import type { InventorySnapshot } from "./inventory.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 350;

export interface TerlHoldApplyResult {
  zeroed: number;
  substituted: number;
  noSubstitute: number;
  restored: number;
  errors: string[];
}

export interface TerlEodResult {
  skipped?: boolean;
  reason?: string;
  posted: boolean;
  inboxes: number;
  shortages: number;
}

export function podLetterOf(account: { tags?: Array<{ tag_name?: string; name?: string }> }):
  | "A"
  | "B"
  | null {
  const tags = (account.tags ?? [])
    .map((tag) => String(tag.tag_name ?? tag.name ?? "").trim().toUpperCase())
    .filter(Boolean);
  const hasA = tags.includes("POD-A");
  const hasB = tags.includes("POD-B");
  if (hasA && !hasB) return "A";
  if (hasB && !hasA) return "B";
  return null;
}

export function seatIsOnWeekPod(
  account: { tags?: Array<{ tag_name?: string; name?: string }> },
  now: Date,
): boolean {
  const letter = podLetterOf(account);
  if (!letter) return true;
  return letter === onWeekCohort(now);
}

export class TerlHoldService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: Pick<
      SmartleadClient,
      | "updateEmailAccount"
      | "addEmailAccountsToCampaign"
      | "removeEmailAccountsFromCampaign"
    >,
    private readonly state: StateStore,
    private readonly slack?: Pick<SlackClient, "notifyDeliverabilityNote">,
  ) {}

  async applyStops(input: {
    domains: string[];
    inventory: InventorySnapshot;
    dryRun?: boolean;
    now?: Date;
  }): Promise<TerlHoldApplyResult> {
    const now = input.now ?? new Date();
    const dryRun = input.dryRun ?? this.config.dryRun;
    const result: TerlHoldApplyResult = {
      zeroed: 0,
      substituted: 0,
      noSubstitute: 0,
      restored: 0,
      errors: [],
    };
    const hosts = new Set(input.domains.map((d) => d.toLowerCase()).filter(Boolean));
    if (!hosts.size) return result;

    const { accounts, campaigns, clients = [] } = input.inventory;
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((row) => [row.id, row]),
    );
    const clientById = new Map(clients.map((row) => [row.id, row]));
    const seats = (accounts as SmartleadAccountWithCampaigns[]).filter((account) => {
      if (!isOutlookMailboxType(account.type)) return false;
      const email = accountEmail(account)?.toLowerCase();
      const host = email?.split("@")[1];
      return Boolean(host && hosts.has(host) && account.id);
    });
    if (!seats.length) return result;

    const ids = seats.map((seat) => seat.id);
    for (const host of hosts) {
      this.state.ensureTenantTerlHold({
        tenant: host,
        domains: [host],
        accountIds: ids,
        now,
      });
    }

    const paused: TerlPausedInbox[] = [];
    for (const seat of seats) {
      const email = accountEmail(seat)!.toLowerCase();
      const tenant = email.split("@")[1] ?? "";
      const clientId = typeof seat.client_id === "number" ? seat.client_id : null;
      const client = clientId != null ? clientById.get(clientId) : undefined;
      paused.push({
        accountId: seat.id,
        email,
        clientId,
        clientName: client ? clientDisplayName(client) : "",
        tenant,
        pausedAt: now.toISOString(),
      });
      if (!dryRun) {
        try {
          await this.smartlead.updateEmailAccount(seat.id, {
            max_email_per_day: 0,
          });
          await sleep(WRITE_GAP_MS);
          result.zeroed += 1;
        } catch (error) {
          result.errors.push(
            `${email}: zero failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        result.zeroed += 1;
      }

      if (!seatIsOnWeekPod(seat, now)) continue;
      for (const campaignId of campaignIdsOf(seat)) {
        const campaign = campaignById.get(campaignId);
        if (!campaign) continue;
        if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") continue;
        if (isAnyShellCampaign(campaign)) continue;
        if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
        const campaignClientId = campaign.client_id;
        if (typeof campaignClientId !== "number") continue;
        const existing = this.state.getTerlSubstitution(campaignId, seat.id);
        if (existing && !existing.restoredAt) {
          this.state.upsertTerlSubstitution({
            ...existing,
            restoreAfter: terlHeldUntil(now).toISOString(),
          });
          continue;
        }
        const client = clientById.get(campaignClientId);
        const clientName = client ? clientDisplayName(client) : `Client ${campaignClientId}`;
        const pick = this.pickSubstitute({
          campaign,
          clientId: campaignClientId,
          stoppedAccountId: seat.id,
          accounts: accounts as SmartleadAccountWithCampaigns[],
          now,
        });
        if (!pick) {
          this.state.upsertTerlSubstitution({
            stoppedAccountId: seat.id,
            stoppedEmail: email,
            substituteAccountId: null,
            substituteEmail: null,
            campaignId,
            campaignName: campaign.name ?? "",
            clientId: campaignClientId,
            clientName,
            tenant,
            stoppedAt: now.toISOString(),
            restoreAfter: terlHeldUntil(now).toISOString(),
            restoredAt: null,
            noSubstitute: true,
          });
          result.noSubstitute += 1;
          continue;
        }
        const brand = brandFromClientDisplayName(clientName);
        const { firstName, lastName } = parsePersonName(pick.from_name);
        if (!dryRun) {
          try {
            await this.smartlead.addEmailAccountsToCampaign(campaignId, [pick.id]);
            await sleep(WRITE_GAP_MS);
            await this.smartlead.updateEmailAccount(pick.id, {
              signature: buildPoolSignature({ firstName, lastName, clientBrand: brand }),
              from_name: `${firstName} ${lastName}`,
              client_id: campaignClientId,
              max_email_per_day: mailboxMessagePerDayTarget(pick, this.config, this.state, now),
            });
            await sleep(WRITE_GAP_MS);
          } catch (error) {
            result.errors.push(
              `${accountEmail(pick)}: substitute failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.state.upsertTerlSubstitution({
              stoppedAccountId: seat.id,
              stoppedEmail: email,
              substituteAccountId: null,
              substituteEmail: null,
              campaignId,
              campaignName: campaign.name ?? "",
              clientId: campaignClientId,
              clientName,
              tenant,
              stoppedAt: now.toISOString(),
              restoreAfter: terlHeldUntil(now).toISOString(),
              restoredAt: null,
              noSubstitute: true,
            });
            result.noSubstitute += 1;
            continue;
          }
        }
        this.state.upsertTerlSubstitution({
          stoppedAccountId: seat.id,
          stoppedEmail: email,
          substituteAccountId: pick.id,
          substituteEmail: accountEmail(pick)?.toLowerCase() ?? "",
          campaignId,
          campaignName: campaign.name ?? "",
          clientId: campaignClientId,
          clientName,
          tenant,
          stoppedAt: now.toISOString(),
          restoreAfter: terlHeldUntil(now).toISOString(),
          restoredAt: null,
          noSubstitute: false,
        });
        result.substituted += 1;
      }
    }

    this.state.recordTerlPausedInboxes({
      ymd: chicagoWallClock(now).ymd,
      inboxes: paused,
    });
    return result;
  }

  async restoreExpired(input: {
    inventory?: InventorySnapshot;
    dryRun?: boolean;
    now?: Date;
  } = {}): Promise<TerlHoldApplyResult> {
    const now = input.now ?? new Date();
    const dryRun = input.dryRun ?? this.config.dryRun;
    const result: TerlHoldApplyResult = {
      zeroed: 0,
      substituted: 0,
      noSubstitute: 0,
      restored: 0,
      errors: [],
    };
    const due = this.state.listExpiredTerlSubstitutions(now);
    const accounts = (input.inventory?.accounts ?? []) as SmartleadAccountWithCampaigns[];
    const byId = new Map(accounts.map((row) => [row.id, row]));
    for (const row of due) {
      if (this.state.isTenantTerlHoldAccount(row.stoppedAccountId, now)) {
        continue;
      }
      const stopped = byId.get(row.stoppedAccountId);
      if (!dryRun) {
        try {
          if (stopped) {
            await this.smartlead.updateEmailAccount(row.stoppedAccountId, {
              max_email_per_day: mailboxMessagePerDayTarget(
                stopped,
                this.config,
                this.state,
                now,
              ),
            });
            await sleep(WRITE_GAP_MS);
          }
          if (row.substituteAccountId) {
            await this.smartlead.removeEmailAccountsFromCampaign(row.campaignId, [
              row.substituteAccountId,
            ]);
            await sleep(WRITE_GAP_MS);
          }
        } catch (error) {
          result.errors.push(
            `${row.stoppedEmail}: restore failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }
      this.state.markTerlSubstitutionRestored(
        terlSubstitutionKey(row.campaignId, row.stoppedAccountId),
        now,
      );
      result.restored += 1;
    }
    return result;
  }

  async postEodDigest(input: { now?: Date; force?: boolean } = {}): Promise<TerlEodResult> {
    const now = input.now ?? new Date();
    const idle = input.force
      ? undefined
      : canonOpsIdleReason({
          timezone: "America/Chicago",
          weekdayOnly: true,
          hourStart: 0,
          hourEnd: 24,
          now,
        });
    if (idle) {
      return { skipped: true, reason: idle, posted: false, inboxes: 0, shortages: 0 };
    }
    const ymd = chicagoWallClock(now, "America/Chicago").ymd;
    if (this.state.terlEodPosted(ymd)) {
      return { skipped: true, reason: "already-posted", posted: false, inboxes: 0, shortages: 0 };
    }
    const inboxes = this.state.listTerlPausedInboxes(ymd);
    const shortages = this.shortagesForDay(ymd);
    const text = terlEodDigestText({ inboxes, shortages });
    if (!text) {
      return { skipped: true, reason: "none", posted: false, inboxes: 0, shortages: 0 };
    }
    if (this.slack?.notifyDeliverabilityNote) {
      await this.slack.notifyDeliverabilityNote(text);
    }
    this.state.markTerlEodPosted(ymd, now);
    return {
      posted: true,
      inboxes: inboxes.length,
      shortages: shortages.length,
    };
  }

  private shortagesForDay(ymd: string): TerlEodShortage[] {
    const out: TerlEodShortage[] = [];
    const seen = new Set<number>();
    for (const row of this.state.listTerlSubstitutions()) {
      if (!row.noSubstitute) continue;
      if (!row.stoppedAt.startsWith(ymd)) continue;
      if (seen.has(row.campaignId)) continue;
      seen.add(row.campaignId);
      const stops = this.state
        .listTerlSubstitutions()
        .filter(
          (item) =>
            item.campaignId === row.campaignId &&
            item.noSubstitute &&
            item.stoppedAt.startsWith(ymd),
        ).length;
      out.push({
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        clientId: row.clientId,
        clientName: row.clientName,
        sending: Math.max(0, 40 - stops),
      });
    }
    return out;
  }

  private pickSubstitute(input: {
    campaign: SmartleadCampaign;
    clientId: number;
    stoppedAccountId: number;
    accounts: SmartleadAccountWithCampaigns[];
    now: Date;
  }): SmartleadAccountWithCampaigns | undefined {
    const used = new Set(
      this.state
        .listActiveTerlSubstitutions()
        .filter((row) => row.stoppedAccountId !== input.stoppedAccountId)
        .map((row) => row.substituteAccountId)
        .filter((id): id is number => typeof id === "number"),
    );
    const onWeek = onWeekCohort(input.now);
    const ranked: SmartleadAccountWithCampaigns[] = [];
    for (const account of input.accounts) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (used.has(account.id)) continue;
      if (campaignIdsOf(account).includes(input.campaign.id)) continue;
      if (!isGenericMailbox(account, email, this.config, this.state)) continue;
      const dedicated = resolveDedicatedGenericClientId(
        account,
        email,
        [],
        this.state,
      );
      const sameClient =
        dedicated === input.clientId || account.client_id === input.clientId;
      if (!sameClient) continue;
      if (owesWarmup(account, email, this.config, this.state)) continue;
      if (account.is_smtp_success === false || account.is_imap_success === false) {
        continue;
      }
      if (
        senderIsAttachBlocked(
          { email, accountId: account.id, domain: email.split("@")[1] },
          this.state,
        )
      ) {
        continue;
      }
      if (this.state.isTenantTerlHoldAccount(account.id, input.now)) continue;
      if (this.state.isCopyCanary(email)) continue;
      ranked.push(account);
    }
    ranked.sort((a, b) => {
      const aPod = podLetterOf(a);
      const bPod = podLetterOf(b);
      const aMatch = aPod === onWeek ? 0 : aPod == null ? 1 : 2;
      const bMatch = bPod === onWeek ? 0 : bPod == null ? 1 : 2;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return (accountEmail(a) ?? "").localeCompare(accountEmail(b) ?? "");
    });
    return ranked[0];
  }
}
