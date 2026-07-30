import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  type SmartleadAccountWithCampaigns,
  type SmartleadClient,
} from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { matchesMailboxIdentity } from "../lib/mailboxIdentity.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";

export type WarmupGateReason = "under_warmed" | "hold_until";

export interface WarmupGateRemoval {
  campaignId: number;
  campaignName: string;
  accountId: number;
  email: string;
  reason: WarmupGateReason;
  daysWarmed: number | null;
  holdUntil?: string;
  tags: string[];
}

export interface WarmupGateResult {
  dryRun: boolean;
  campaignsScanned: number;
  accountsChecked: number;
  removed: number;
  skipped: number;
  pausedCampaigns: number[];
  removals: WarmupGateRemoval[];
  errors: string[];
}

/**
 * Keep ACTIVE campaigns from sending on mailboxes that are not ready:
 * - warmed < MIN_CAMPAIGN_WARMUP_DAYS (default 14)
 * - still tagged HOLD-UNTIL-YYYY-MM-DD (recovery hold not expired)
 */
export class WarmupGateService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(): Promise<WarmupGateResult> {
    const result: WarmupGateResult = {
      dryRun: this.config.dryRun,
      campaignsScanned: 0,
      accountsChecked: 0,
      removed: 0,
      skipped: 0,
      pausedCampaigns: [],
      removals: [],
      errors: [],
    };

    if (!this.config.enableWarmupGate) {
      console.log("[warmup-gate] Disabled — skipping");
      return result;
    }

    console.log(
      `[warmup-gate] Starting (${result.dryRun ? "DRY RUN" : "LIVE"}) minDays=${this.config.campaignMinWarmupDays}`,
    );

    let campaigns;
    try {
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list campaigns: ${message}`);
      await this.finish(result);
      return result;
    }

    const active = campaigns.filter((c) => isActiveCampaignStatus(c.status));
    result.campaignsScanned = active.length;

    let accountIndex: Map<number, SmartleadAccountWithCampaigns>;
    try {
      const all = await this.smartlead.listAllEmailAccounts({
        fetchCampaigns: false,
      });
      accountIndex = new Map(all.map((a) => [a.id, a]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list accounts: ${message}`);
      await this.finish(result);
      return result;
    }

    for (const campaign of active) {
      let campaignAccounts: SmartleadEmailAccount[];
      try {
        campaignAccounts = await this.smartlead.getCampaignEmailAccounts(
          campaign.id,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`campaign ${campaign.id} accounts: ${message}`);
        continue;
      }

      const remainingIds = new Set(campaignAccounts.map((a) => a.id));
      const toRemove: WarmupGateRemoval[] = [];

      for (const row of campaignAccounts) {
        result.accountsChecked += 1;
        let account: SmartleadAccountWithCampaigns =
          accountIndex.get(row.id) ?? (row as SmartleadAccountWithCampaigns);

        // List payloads often omit warmup_details — fetch when needed.
        if (!warmupStartedAt(account)) {
          try {
            account = await this.smartlead.getEmailAccount(row.id);
            accountIndex.set(row.id, account);
            await sleep(80);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            result.errors.push(`get account ${row.id}: ${message}`);
          }
        }

        const email = accountEmail(account) || accountEmail(row) || `id:${row.id}`;
        const tags = tagNames(account);
        const holdUntil = activeHoldUntilDate(tags);
        const started = warmupStartedAt(account);
        const daysWarmed = started != null ? daysSince(started) : null;
        const underWarmed =
          daysWarmed == null || daysWarmed < this.config.campaignMinWarmupDays;

        if (holdUntil) {
          toRemove.push({
            campaignId: campaign.id,
            campaignName: campaign.name,
            accountId: row.id,
            email,
            reason: "hold_until",
            daysWarmed:
              daysWarmed != null ? Number(daysWarmed.toFixed(1)) : null,
            holdUntil,
            tags,
          });
          continue;
        }

        // Pre-warmed generics are already warm; Smartlead's warmup start date
        // reflects when warmup was last toggled, not their real age, so it must
        // not be used to pull them off live campaigns.
        const prewarmed = matchesMailboxIdentity(
          { ...account, ...(email.includes("@") ? { from_email: email } : {}) },
          this.config.extraGenericMailboxes,
        );

        if (underWarmed && prewarmed) {
          result.skipped += 1;
          console.log(
            `[warmup-gate] Keeping pre-warmed generic \`${email}\` on campaign ${campaign.id} (${daysWarmed == null ? "unknown" : daysWarmed.toFixed(1)}d reported)`,
          );
          continue;
        }

        if (underWarmed) {
          toRemove.push({
            campaignId: campaign.id,
            campaignName: campaign.name,
            accountId: row.id,
            email,
            reason: "under_warmed",
            daysWarmed:
              daysWarmed != null ? Number(daysWarmed.toFixed(1)) : null,
            tags,
          });
        }
      }

      for (const removal of toRemove) {
        if (result.dryRun) {
          result.removed += 1;
          result.removals.push(removal);
          remainingIds.delete(removal.accountId);
          continue;
        }

        try {
          if (remainingIds.size <= 1 && remainingIds.has(removal.accountId)) {
            // Smartlead rejects removing the last account from an ACTIVE campaign.
            try {
              await this.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
              if (!result.pausedCampaigns.includes(campaign.id)) {
                result.pausedCampaigns.push(campaign.id);
              }
            } catch (pauseError) {
              const message =
                pauseError instanceof Error
                  ? pauseError.message
                  : String(pauseError);
              result.errors.push(
                `pause campaign ${campaign.id} before last remove: ${message}`,
              );
            }
          }

          await this.smartlead.removeEmailAccountsFromCampaign(campaign.id, [
            removal.accountId,
          ]);
          remainingIds.delete(removal.accountId);
          result.removed += 1;
          result.removals.push(removal);

          if (removal.reason === "under_warmed") {
            try {
              await this.smartlead.configureWarmup(removal.accountId, {
                warmup_enabled: true,
                total_warmup_per_day: this.config.warmupTotalPerDay,
                daily_rampup: this.config.warmupDailyRampup,
                reply_rate_percentage: this.config.warmupReplyRatePercentage,
              });
            } catch (warmupError) {
              const message =
                warmupError instanceof Error
                  ? warmupError.message
                  : String(warmupError);
              result.errors.push(
                `warmup after remove ${removal.email}: ${message}`,
              );
            }
          }
          await sleep(250);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Retry once after pause if Smartlead complains about last account
          if (/at least one|all accounts|last/i.test(message)) {
            try {
              await this.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
              if (!result.pausedCampaigns.includes(campaign.id)) {
                result.pausedCampaigns.push(campaign.id);
              }
              await this.smartlead.removeEmailAccountsFromCampaign(
                campaign.id,
                [removal.accountId],
              );
              remainingIds.delete(removal.accountId);
              result.removed += 1;
              result.removals.push(removal);
              continue;
            } catch (retryError) {
              const retryMsg =
                retryError instanceof Error
                  ? retryError.message
                  : String(retryError);
              result.skipped += 1;
              result.errors.push(
                `remove ${removal.email} from ${campaign.id}: ${retryMsg}`,
              );
              continue;
            }
          }
          result.skipped += 1;
          result.errors.push(
            `remove ${removal.email} from ${campaign.id}: ${message}`,
          );
        }
      }
    }

    this.state.setLastWarmupGateAt(new Date().toISOString());
    await this.finish(result);
    return result;
  }

  private async finish(result: WarmupGateResult): Promise<void> {
    await this.state.save();
    console.log("[warmup-gate] Done", {
      dryRun: result.dryRun,
      campaignsScanned: result.campaignsScanned,
      accountsChecked: result.accountsChecked,
      removed: result.removed,
      skipped: result.skipped,
      pausedCampaigns: result.pausedCampaigns,
      errors: result.errors.length,
    });

    if (result.removed > 0 || result.errors.length > 0) {
      await this.slack.notifyWarmupGate(result).catch((error) => {
        console.error("[warmup-gate] Slack notify failed", error);
      });
    }
  }
}

export function isActiveCampaignStatus(status: string | undefined): boolean {
  const s = String(status || "").toUpperCase();
  return s === "ACTIVE" || s === "START";
}

export function tagNames(account: SmartleadEmailAccount): string[] {
  return (account.tags ?? [])
    .map((t) => String(t.tag_name ?? t.name ?? "").trim())
    .filter(Boolean);
}

/** Return HOLD-UNTIL date if the hold has not expired yet (end of that UTC day). */
export function activeHoldUntilDate(tags: string[], now = new Date()): string | null {
  for (const tag of tags) {
    const match = /^HOLD-UNTIL-(\d{4}-\d{2}-\d{2})$/i.exec(tag);
    if (!match) continue;
    const end = Date.parse(`${match[1]}T23:59:59.999Z`);
    if (Number.isFinite(end) && end >= now.getTime()) return match[1];
  }
  return null;
}

export function warmupStartedAt(
  account: SmartleadAccountWithCampaigns & {
    created_at?: string;
    warmup_details?: {
      created_at?: string;
      warmup_created_at?: string;
      status?: string;
    } | null;
  },
): string | null {
  const wd = account.warmup_details;
  return (
    wd?.created_at ||
    wd?.warmup_created_at ||
    account.created_at ||
    null
  );
}

export function daysSince(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.NaN;
  return (now - t) / 86_400_000;
}
