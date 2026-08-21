import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { isCanaryCampaign, canaryAllowsClientInbox } from "../lib/canaryCampaign.js";
import {
  isClientInbox,
  isRestEligibleMailbox,
} from "../lib/clientInbox.js";
import { sleep } from "../lib/http.js";
import {
  isOffWeek,
  onWeekCohort,
  restCohortOf,
  type RestCohort,
} from "../lib/restCohort.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isExcluded } from "./campaignTopUp.js";
import { activeHoldUntilDate, tagNames } from "./warmupGate.js";

/**
 * D41 + D42 — 2 weeks on / 2 weeks off for client inboxes and generics.
 *
 * Off-week mailboxes are removed from live campaigns (warmup stays on).
 * Health can veto putting a mailbox back on if same-ESP inbox is known-bad;
 * no score allows the first swap so rotation can start. On-week generics
 * remain the spare tire; resting generics are not top-up supply.
 */

export interface ClientRestResult {
  dryRun: boolean;
  onWeekCohort: RestCohort;
  examined: number;
  benched: Array<{ email: string; campaignIds: number[] }>;
  restored: Array<{ email: string; campaignIds: number[] }>;
  vetoed: Array<{ email: string; sameEspInbox: number }>;
  skipped: string[];
  errors: string[];
}

function clientKeyOf(account: SmartleadAccountWithCampaigns): string {
  return typeof account.client_id === "number"
    ? `id:${account.client_id}`
    : "unknown";
}

export function shouldVetoRestRestore(
  lastSameEspInbox: number | null | undefined,
  threshold: number,
): boolean {
  if (lastSameEspInbox == null || !Number.isFinite(lastSameEspInbox)) {
    return false;
  }
  return lastSameEspInbox < threshold;
}

export class ClientRestService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean; now?: Date } = {}): Promise<ClientRestResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const now = opts.now ?? new Date();
    const result: ClientRestResult = {
      dryRun,
      onWeekCohort: onWeekCohort(now),
      examined: 0,
      benched: [],
      restored: [],
      vetoed: [],
      skipped: [],
      errors: [],
    };

    if (!this.config.enableClientRest) {
      console.log("[client-rest] Disabled (ENABLE_CLIENT_REST=false)");
      return result;
    }

    const [campaigns, accounts] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
    ]);

    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c]),
    );
    const activeByClient = new Map<number, SmartleadCampaign[]>();
    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      const clientId = campaign.client_id;
      if (typeof clientId !== "number") continue;
      const list = activeByClient.get(clientId) ?? [];
      list.push(campaign);
      activeByClient.set(clientId, list);
    }

    const membership = new Map<number, number>();
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      for (const id of campaignIdsOf(account)) {
        membership.set(id, (membership.get(id) ?? 0) + 1);
      }
    }

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (!isRestEligibleMailbox(account, email, this.config, this.state)) {
        continue;
      }
      const clientOwned = isClientInbox(account, email, this.config, this.state);
      result.examined += 1;

      if (this.state.getHeldInbox(email) || activeHoldUntilDate(tagNames(account))) {
        result.skipped.push(`${email}: held`);
        continue;
      }

      const off = isOffWeek(email, now);
      const existing = this.state.getRestingInbox(email);
      const onCampaigns = campaignIdsOf(account).filter((id) => {
        const campaign = campaignById.get(id);
        return String(campaign?.status ?? "").toUpperCase() === "ACTIVE";
      });

      if (off) {
        if (!onCampaigns.length && existing) continue;
        const removed: number[] = [];
        for (const campaignId of onCampaigns) {
          const remaining = membership.get(campaignId) ?? 0;
          if (remaining <= 1) {
            result.skipped.push(
              `${email}: last account on #${campaignId} — wait for top-up`,
            );
            continue;
          }
          try {
            if (!dryRun) {
              await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
                account.id,
              ]);
              await sleep(150);
            }
            membership.set(campaignId, remaining - 1);
            removed.push(campaignId);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            result.errors.push(`${email} remove #${campaignId}: ${message}`);
          }
        }
        if (removed.length || !existing) {
          const record = {
            accountId: account.id,
            email,
            clientId: clientKeyOf(account),
            cohort: restCohortOf(email),
            restingSince: existing?.restingSince ?? now.toISOString(),
            removedFromCampaigns: [
              ...new Set([
                ...(existing?.removedFromCampaigns ?? []),
                ...removed,
                ...onCampaigns,
              ]),
            ],
            lastSameEspInbox: existing?.lastSameEspInbox ?? null,
          };
          if (!dryRun) this.state.markRestingInbox(record);
          if (removed.length) {
            result.benched.push({ email, campaignIds: removed });
          }
        }
        continue;
      }

      // On-week: put back unless health vetoes a known-bad same-ESP score.
      // Available pool generics with no campaign history just clear the rest flag.
      if (!existing && !onCampaigns.length) {
        continue;
      }
      if (
        shouldVetoRestRestore(
          existing?.lastSameEspInbox,
          this.config.remediationInboxThreshold,
        )
      ) {
        result.vetoed.push({
          email,
          sameEspInbox: existing!.lastSameEspInbox as number,
        });
        result.skipped.push(
          `${email}: veto same-ESP ${existing!.lastSameEspInbox}%`,
        );
        continue;
      }

      const clientId =
        typeof account.client_id === "number" ? account.client_id : null;
      const targets = this.restoreTargets(
        existing?.removedFromCampaigns ?? onCampaigns,
        clientId,
        activeByClient,
        campaignById,
        email,
        clientOwned,
      );
      const added: number[] = [];
      for (const campaignId of targets) {
        if (onCampaigns.includes(campaignId)) continue;
        try {
          if (!dryRun) {
            await this.smartlead.addEmailAccountsToCampaign(campaignId, [
              account.id,
            ]);
            await sleep(150);
          }
          added.push(campaignId);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(`${email} restore #${campaignId}: ${message}`);
        }
      }
      if (!dryRun) this.state.clearRestingInbox(email);
      if (added.length || existing) {
        result.restored.push({ email, campaignIds: added });
      }
    }

    if (!dryRun) await this.state.save();

    console.log(
      `[client-rest] onWeek=${result.onWeekCohort} examined=${result.examined} benched=${result.benched.length} restored=${result.restored.length} vetoed=${result.vetoed.length} errors=${result.errors.length}`,
    );

    if (result.benched.length || result.restored.length || result.vetoed.length) {
      await this.notify(result);
    }
    return result;
  }

  private restoreTargets(
    previous: number[],
    clientId: number | null,
    activeByClient: Map<number, SmartleadCampaign[]>,
    campaignById: Map<number, SmartleadCampaign>,
    email: string,
    applyCanarySlice: boolean,
  ): number[] {
    const allowsCanary = (campaign: SmartleadCampaign): boolean => {
      if (!applyCanarySlice) return true;
      if (
        !isCanaryCampaign(
          campaign,
          new Date(),
          this.config.canaryCampaignDays,
        )
      ) {
        return true;
      }
      return canaryAllowsClientInbox(
        email,
        this.config.canaryClientInboxPercent,
      );
    };
    const fromPrevious = previous.filter((id) => {
      const campaign = campaignById.get(id);
      if (!campaign) return false;
      if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") return false;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) return false;
      return allowsCanary(campaign);
    });
    if (fromPrevious.length) return fromPrevious;
    if (clientId == null) return [];
    return (activeByClient.get(clientId) ?? [])
      .filter((campaign) => allowsCanary(campaign))
      .map((c) => c.id);
  }

  private async notify(result: ClientRestResult): Promise<void> {
    const lines = [
      `${result.dryRun ? "[DRY RUN] " : ""}Sender rest (2 weeks on / 2 weeks off; clients + generics), on-week cohort ${result.onWeekCohort}:`,
      `- ${result.benched.length} mailbox(es) taken off live campaigns`,
      `- ${result.restored.length} mailbox(es) put back on`,
    ];
    if (result.vetoed.length) {
      lines.push(
        `- ${result.vetoed.length} handoff(s) vetoed (known-bad same-ESP)`,
      );
    }
    try {
      await this.slack.send(lines.join("\n"));
    } catch (error) {
      console.warn("[client-rest] Slack notify failed", error);
    }
  }
}
