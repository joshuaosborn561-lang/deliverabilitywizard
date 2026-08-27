import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
  type SmartleadClient,
} from "../clients/smartlead.js";
import type { InventorySnapshot } from "./inventory.js";
import { sleep } from "../lib/http.js";
import { MATCH_THRESHOLD, scoreNameMatch } from "../lib/nameMatch.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";

// D128 — a leftover HOLD-UNTIL tag is inert residue, never a pull, so the
// gate's only removal reason is an unfinished warmup.
export type WarmupGateReason = "under_warmed";

export interface WarmupGateRemoval {
  campaignId: number;
  campaignName: string;
  accountId: number;
  email: string;
  reason: WarmupGateReason;
  daysWarmed: number | null;
  tags: string[];
}

export interface WarmupGateResult {
  /** D139 — the warmup days this gate enforced (config, 21). */
  owedDays: number;
  dryRun: boolean;
  campaignsScanned: number;
  accountsChecked: number;
  removed: number;
  skipped: number;
  pausedCampaigns: number[];
  removals: WarmupGateRemoval[];
  errors: string[];
}

export function isPrewarmedGeneric(
  account: Pick<SmartleadEmailAccount, "from_name">,
  email: string,
  config: Pick<AppConfig, "extraGenericMailboxes" | "prewarmedDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
): boolean {
  const normalizedEmail = email.toLowerCase();
  const domain = normalizedEmail.split("@")[1] ?? "";
  // D142 — pre-warmed is a policy flag Josh grants, never implied by
  // generic-pool membership. Only PREWARMED_DOMAINS skips the clock.
  if (config.prewarmedDomains.includes(domain)) return true;
  if (state.getPoolMailbox(normalizedEmail)?.prewarmed === true) return true;
  return config.extraGenericMailboxes.some(
    (identifier) =>
      scoreNameMatch(identifier, {
        fromName: account.from_name,
        email: normalizedEmail,
      }).score >= MATCH_THRESHOLD,
  );
}

/**
 * Keep ACTIVE campaigns from sending on mailboxes that have not served the
 * 21-day clock (MIN_CAMPAIGN_WARMUP_DAYS / freshInboxWarmupDays, D50/D105).
 *
 * Age is measured from the InboxKit import stamp when the mailbox is in
 * the pool. Smartlead's warmup record is the fallback only (D1). HOLD-UNTIL
 * tags are inert residue and never a pull (D51/D59/D128).
 */
export class WarmupGateService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { inventory?: InventorySnapshot } = {}): Promise<WarmupGateResult> {
    const result: WarmupGateResult = {
      owedDays: this.config.freshInboxWarmupDays,
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
      `[warmup-gate] Starting (${result.dryRun ? "DRY RUN" : "LIVE"}) minDays=${this.config.campaignMinWarmupDays} freshDays=${this.config.freshInboxWarmupDays}`,
    );

    let campaigns;
    let accountIndex: Map<number, SmartleadAccountWithCampaigns>;
    try {
      if (opts.inventory) {
        campaigns = opts.inventory.campaigns;
        accountIndex = new Map(
          opts.inventory.accounts.map((account) => [account.id, account]),
        );
      } else {
        campaigns = await this.smartlead.listCampaigns();
        const all = await this.smartlead.listAllEmailAccounts({
          fetchCampaigns: false,
        });
        accountIndex = new Map(all.map((a) => [a.id, a]));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`inventory: ${message}`);
      await this.finish(result);
      return result;
    }

    const active = campaigns.filter((c) => isActiveCampaignStatus(c.status));
    result.campaignsScanned = active.length;

    for (const campaign of active) {
      let campaignAccounts: SmartleadEmailAccount[];
      if (opts.inventory) {
        campaignAccounts = opts.inventory.accounts.filter((account) =>
          campaignIdsOf(account).includes(campaign.id),
        );
      } else {
        try {
          campaignAccounts = await this.smartlead.getCampaignEmailAccounts(
            campaign.id,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`campaign ${campaign.id} accounts: ${message}`);
          continue;
        }
      }

      const remainingIds = new Set(campaignAccounts.map((a) => a.id));
      const toRemove: WarmupGateRemoval[] = [];

      for (const row of campaignAccounts) {
        result.accountsChecked += 1;
        let account: SmartleadAccountWithCampaigns =
          accountIndex.get(row.id) ?? (row as SmartleadAccountWithCampaigns);

        const emailGuess =
          accountEmail(account) || accountEmail(row) || `id:${row.id}`;
        const poolClock = poolWarmedAt(emailGuess, this.state);

        // List payloads often omit warmup_details — fetch when the pool
        // import stamp is missing and Smartlead has not given a start yet.
        if (!poolClock && !warmupStartedAt(account)) {
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
        const started = warmupClockStartedAt(account, email, this.state);
        const daysWarmed = started != null ? daysSince(started) : null;

        if (isWarmupGateExempt(tags) || this.state.isCopyCanary(email)) {
          continue;
        }

        // D128 — a leftover HOLD-UNTIL tag is not a pull. Pulls are
        // kill-only (D51) plus this 21-day clock (D105); the hold system
        // was wiped (D59) and its tags are inert residue.

        // Pre-warmed generics are already warm; Smartlead's warmup start date
        // reflects when warmup was last toggled, not their real age, so it must
        // not be used to pull them off live campaigns.
        const prewarmed = isPrewarmedGeneric(
          account,
          email,
          this.config,
          this.state,
        );
        const owedDays = owedWarmupDays(prewarmed, this.config);
        const underWarmed =
          daysWarmed == null || daysWarmed < owedDays;

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
              this.state.markPendingResume({
                campaignId: campaign.id,
                campaignName: String(campaign.name ?? campaign.id),
                pausedAt: new Date().toISOString(),
                reason: "warmup_gate_last_account",
              });
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
          this.state.recordWarmupGatePull({
            accountId: removal.accountId,
            campaignId: campaign.id,
            email: removal.email,
            campaignName: removal.campaignName,
          });

          // D143 — one re-enable per account per day. The 8/27 fight (an
          // outside writer re-adding 84 memberships every pass) had this
          // rewriting identical warmup settings 84 times per 15 minutes.
          if (
            removal.reason === "under_warmed" &&
            !this.state.warmupEnsuredRecently(removal.accountId)
          ) {
            try {
              await this.smartlead.configureWarmup(removal.accountId, {
                warmup_enabled: true,
                total_warmup_per_day: this.config.warmupTotalPerDay,
                daily_rampup: this.config.warmupDailyRampup,
                reply_rate_percentage: this.config.warmupReplyRatePercentage,
              });
              this.state.markWarmupEnsured(removal.accountId);
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
              this.state.markPendingResume({
                campaignId: campaign.id,
                campaignName: String(campaign.name ?? campaign.id),
                pausedAt: new Date().toISOString(),
                reason: "warmup_gate_last_account",
              });
              await this.smartlead.removeEmailAccountsFromCampaign(
                campaign.id,
                [removal.accountId],
              );
              remainingIds.delete(removal.accountId);
              result.removed += 1;
              result.removals.push(removal);
              this.state.recordWarmupGatePull({
                accountId: removal.accountId,
                campaignId: campaign.id,
                email: removal.email,
                campaignName: removal.campaignName,
              });
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

    // D143 — a membership this gate already removed can only be back because
    // something outside this app re-added it. Say so once per pass, loudly;
    // the EOD brief carries the human ask.
    const boomerangs = this.state.listWarmupGateBoomerangs();
    if (boomerangs.length) {
      const top = boomerangs[0]!;
      console.warn(
        `[warmup-gate] boomerang: ${boomerangs.length} membership(s) re-added from outside this app after removal (top: ${top.email} on #${top.campaignId} ×${top.count} in 24h) — see the EOD brief (D143)`,
      );
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

    // notifyWarmupGate drops rate-limit-only noise when nothing was pulled, so
    // a Smartlead 429 no longer pages Slack as a fake "pulled" alert.
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

export const WARMUP_GATE_EXEMPT_TAG = "WARMUP-GATE-EXEMPT";

/** Accounts carrying this tag skip both the under-warmed and hold-until checks. */
export function isWarmupGateExempt(tags: string[]): boolean {
  return tags.some((t) => t.trim().toUpperCase() === WARMUP_GATE_EXEMPT_TAG);
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

/**
 * D41 / D50 — fresh InboxKit inboxes owe 21 days. Pre-warmed fleets stay
 * on campaignMinWarmupDays (also 21) but the gate keeps them anyway.
 */
export function owedWarmupDays(
  prewarmed: boolean,
  config: Pick<AppConfig, "campaignMinWarmupDays" | "freshInboxWarmupDays">,
): number {
  return prewarmed ? config.campaignMinWarmupDays : config.freshInboxWarmupDays;
}

/**
 * D139 — staffing must not hand the gate its next pull. An inbox that owes
 * warmup days is not supply: same clock and exemptions as the gate itself
 * (WARMUP-GATE-EXEMPT tag, pre-warmed fleets, canaries). A mailbox with no
 * readable clock owes by default — fail closed, exactly like the gate.
 */
export function owesWarmup(
  account: Parameters<typeof warmupStartedAt>[0] & {
    tags?: Array<{ tag_name?: unknown; name?: unknown }>;
  },
  email: string,
  config: Pick<
    AppConfig,
    | "campaignMinWarmupDays"
    | "freshInboxWarmupDays"
    | "prewarmedDomains"
    | "extraGenericMailboxes"
  >,
  state: Pick<StateStore, "getPoolMailbox" | "isCopyCanary">,
): boolean {
  if (isWarmupGateExempt(tagNames(account as SmartleadEmailAccount))) return false;
  if (state.isCopyCanary(email)) return false;
  if (isPrewarmedGeneric(account as SmartleadEmailAccount, email, config, state)) {
    return false;
  }
  const started = warmupClockStartedAt(account, email, state);
  const days = started != null ? daysSince(started) : null;
  return days == null || days < owedWarmupDays(false, config);
}

/** InboxKit import stamp when the mailbox is in the pool. */
export function poolWarmedAt(
  email: string,
  state: Pick<StateStore, "getPoolMailbox">,
): string | null {
  const stamp = state.getPoolMailbox(email.toLowerCase())?.warmedAt;
  if (!stamp || !Number.isFinite(Date.parse(stamp))) return null;
  return stamp;
}

/**
 * D1 / D50 — live-send age starts at InboxKit import when we have it.
 * Smartlead's warmup record is the fallback only.
 */
export function warmupClockStartedAt(
  account: Parameters<typeof warmupStartedAt>[0],
  email: string,
  state: Pick<StateStore, "getPoolMailbox">,
): string | null {
  return poolWarmedAt(email, state) ?? warmupStartedAt(account);
}

export function daysSince(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.NaN;
  return (now - t) / 86_400_000;
}
