import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { isGenericMailbox } from "../lib/clientInbox.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isExcluded } from "./campaignTopUp.js";
import { activeHoldUntilDate, tagNames } from "./warmupGate.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface GenericSendRestResult {
  dryRun: boolean;
  examined: number;
  clocksStarted: number;
  benched: Array<{ email: string; campaignIds: number[] }>;
  released: string[];
  skipped: string[];
  errors: string[];
}

export function genericSendTenureDays(
  startedAt: string | undefined,
  now: Date,
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return (now.getTime() - start) / MS_PER_DAY;
}

/**
 * D43 — generics sit after ~14 days of live send, then become supply again
 * after the same sit. Staggered by when each box started sending, not a
 * fleet-wide A/B drop.
 */
export class GenericSendRestService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean; now?: Date } = {}): Promise<GenericSendRestResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const now = opts.now ?? new Date();
    const result: GenericSendRestResult = {
      dryRun,
      examined: 0,
      clocksStarted: 0,
      benched: [],
      released: [],
      skipped: [],
      errors: [],
    };

    if (!this.config.enableGenericSendRest) {
      console.log("[generic-rest] Disabled (ENABLE_GENERIC_SEND_REST=false)");
      return result;
    }

    const [campaigns, accounts] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
    ]);
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c]),
    );
    const membership = new Map<number, number>();
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      for (const id of campaignIdsOf(account)) {
        membership.set(id, (membership.get(id) ?? 0) + 1);
      }
    }

    const owed = this.config.genericSendRestDays;

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (!isGenericMailbox(account, email, this.config, this.state)) continue;
      if (this.state.isCopyCanary(email)) {
        result.skipped.push(`${email}: copy canary`);
        continue;
      }
      result.examined += 1;

      if (this.state.getHeldInbox(email) || activeHoldUntilDate(tagNames(account))) {
        result.skipped.push(`${email}: held`);
        continue;
      }

      const existing = this.state.getRestingInbox(email);
      if (existing && existing.kind !== "generic" && existing.kind !== undefined) {
        continue;
      }

      if (existing?.kind === "generic" || existing?.cohort === "send") {
        const sat = genericSendTenureDays(existing.restingSince, now) ?? 0;
        if (sat >= owed) {
          if (!dryRun) {
            this.state.clearRestingInbox(email);
            this.state.clearGenericSendStartedAt(email);
            const pool = this.state.getPoolMailbox(email);
            if (pool) {
              this.state.upsertPoolMailbox({
                ...pool,
                assignedAt: undefined,
                status: pool.status === "assigned" ? "available" : pool.status,
              });
            }
          }
          result.released.push(email);
        }
        continue;
      }

      const onCampaigns = campaignIdsOf(account).filter((id) => {
        const campaign = campaignById.get(id);
        if (!campaign) return false;
        if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") return false;
        if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) return false;
        return true;
      });

      if (!onCampaigns.length) continue;

      const startedAt =
        this.state.getGenericSendStartedAt(email) ??
        this.state.getPoolMailbox(email)?.assignedAt;
      if (!startedAt) {
        if (!dryRun) this.state.markGenericSendStartedAt(email, now.toISOString());
        result.clocksStarted += 1;
        continue;
      }

      const tenure = genericSendTenureDays(startedAt, now) ?? 0;
      if (tenure < owed) continue;

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
      if (removed.length) {
        if (!dryRun) {
          this.state.markRestingInbox({
            accountId: account.id,
            email,
            clientId: "generic",
            cohort: "send",
            kind: "generic",
            restingSince: now.toISOString(),
            removedFromCampaigns: removed,
            lastSameEspInbox: null,
          });
        }
        result.benched.push({ email, campaignIds: removed });
      }
    }

    if (!dryRun) await this.state.save();
    console.log(
      `[generic-rest] examined=${result.examined} clocks=${result.clocksStarted} benched=${result.benched.length} released=${result.released.length} errors=${result.errors.length}`,
    );
    if (result.benched.length || result.released.length) {
      try {
        await this.slack.send(
          [
            `${dryRun ? "Preview — " : ""}Spare inbox rotation`,
            `${result.benched.length} spare inbox${result.benched.length === 1 ? "" : "es"} came off campaigns after about ${owed} days of sending. They’ll sit about ${owed} days, then we can use them again.`,
            result.released.length
              ? `${result.released.length} spare${result.released.length === 1 ? "" : "s"} finished sitting and are available again.`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (error) {
        console.warn("[generic-rest] Slack notify failed", error);
      }
    }
    return result;
  }
}
