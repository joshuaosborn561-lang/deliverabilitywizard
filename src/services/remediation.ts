import type { AppConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  parseSenderInboxRates,
  uniqueBlacklistedDomains,
} from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountDomain,
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { ApiError, sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";

export interface RemediationResult {
  blacklistedDomains: string[];
  deletedSmartleadAccounts: Array<{ id: number; email: string; domain: string }>;
  purgedInboxKitDomains: string[];
  recoveredInboxes: Array<{
    id: number;
    email: string;
    inboxRate: number;
    removedFromCampaigns: number[];
    holdUntil?: string;
    tagName?: string;
    warmupEnabled?: boolean;
  }>;
  holdTagged: number;
  pausedCampaigns: number[];
  errors: string[];
  dryRun: boolean;
}

export class RemediationService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly inboxkit: InboxKitClient | null,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(): Promise<RemediationResult> {
    const result: RemediationResult = {
      blacklistedDomains: [],
      deletedSmartleadAccounts: [],
      purgedInboxKitDomains: [],
      recoveredInboxes: [],
      holdTagged: 0,
      pausedCampaigns: [],
      errors: [],
      dryRun: this.config.dryRun || !this.config.enableRemediation,
    };

    if (!this.config.enableRemediation && !this.config.dryRun) {
      console.log(
        "[remediation] Disabled (set ENABLE_REMEDIATION=true to auto-delete/recover)",
      );
      return result;
    }

    console.log(
      `[remediation] Starting (${result.dryRun ? "DRY RUN" : "LIVE"})`,
    );

    const testIds = [
      ...new Set(
        Object.values(this.state.get().testedCampaigns).flatMap((c) => c.testIds),
      ),
    ];

    // 1) Collect blacklisted sending domains from SmartDelivery reports
    const blacklistHits = [];
    for (const testId of testIds.slice(0, 40)) {
      try {
        const [domainRaw, ipRaw] = await Promise.all([
          this.smartDelivery.getDomainBlacklist(testId).catch(() => []),
          this.smartDelivery.getIpBlacklist(testId).catch(() => []),
        ]);
        blacklistHits.push(
          ...parseDomainBlacklistHits(domainRaw),
          ...parseIpBlacklistHits(ipRaw),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`blacklist fetch ${testId}: ${message}`);
      }
    }
    const blacklistedDomains = uniqueBlacklistedDomains(blacklistHits).map((d) =>
      d.toLowerCase(),
    );
    result.blacklistedDomains = blacklistedDomains;
    const blacklistedSet = new Set(blacklistedDomains);

    // 2) Collect per-sender inbox rates
    const inboxRates = new Map<string, number>();
    for (const testId of testIds.slice(0, 40)) {
      try {
        const raw = await this.smartDelivery.getSenderAccountReport(testId);
        for (const row of parseSenderInboxRates(raw, testId)) {
          const key = row.email.toLowerCase();
          const prev = inboxRates.get(key);
          // Keep the worst (lowest) observed rate
          if (prev === undefined || row.inboxRate < prev) {
            inboxRates.set(key, row.inboxRate);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`sender report ${testId}: ${message}`);
      }
    }

    // Also fold mailbox-summary placement scores
    try {
      const summary = await this.smartDelivery.getMailboxSummary();
      if (Array.isArray(summary)) {
        for (const row of summary) {
          const email = row.from_email?.trim().toLowerCase();
          const score =
            typeof row.placement_score === "number"
              ? row.placement_score
              : undefined;
          if (!email || score === undefined) continue;
          const prev = inboxRates.get(email);
          if (prev === undefined || score < prev) inboxRates.set(email, score);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`mailbox-summary: ${message}`);
    }

    // 3) Load Smartlead accounts
    let accounts: SmartleadAccountWithCampaigns[] = [];
    try {
      accounts = await this.smartlead.listAllEmailAccounts({
        fetchCampaigns: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list email accounts: ${message}`);
      await this.finish(result);
      return result;
    }

    // Index campaigns for status checks
    let campaignStatus = new Map<number, string>();
    try {
      const campaigns = await this.smartlead.listCampaigns();
      campaignStatus = new Map(
        campaigns.map((c) => [c.id, String(c.status || "").toUpperCase()]),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list campaigns: ${message}`);
    }

    // 4) Delete blacklisted domains from Smartlead + InboxKit
    for (const domain of blacklistedDomains) {
      const slKey = `remediate-domain-sl:${domain}`;
      const ikKey = `remediate-domain-ik:${domain}`;
      // Back-compat with older single-key dedupe
      const legacyKey = `remediate-domain:${domain}`;

      const domainAccounts = accounts.filter(
        (a) => accountDomain(a) === domain,
      );

      if (!this.state.hasRemediation(slKey) && !this.state.hasRemediation(legacyKey)) {
        for (const account of domainAccounts) {
          const email = accountEmail(account) || `id:${account.id}`;
          try {
            if (!result.dryRun) {
              await this.smartlead.deleteEmailAccount(account.id);
              await sleep(200);
            }
            result.deletedSmartleadAccounts.push({
              id: account.id,
              email,
              domain,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.errors.push(`delete SL account ${email}: ${message}`);
          }
        }
        this.state.markRemediation(slKey);
      }

      if (!this.state.hasRemediation(ikKey)) {
        if (this.inboxkit) {
          try {
            if (!result.dryRun) {
              await this.inboxkit.purgeDomain(domain);
            }
            result.purgedInboxKitDomains.push(domain);
            this.state.markRemediation(ikKey);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Domain may live outside InboxKit (Google Workspace, etc.)
            if (/not found|404/i.test(message)) {
              result.errors.push(
                `InboxKit: domain ${domain} not found (skipped purge — may not be managed there)`,
              );
              // Don't mark — a later run may find it after workspace fixes
            } else {
              result.errors.push(`InboxKit purge ${domain}: ${message}`);
            }
          }
        } else {
          result.errors.push(
            `InboxKit not configured — skipped purge for ${domain}`,
          );
        }
      }

      // Keep legacy key so older monitors don't re-delete Smartlead accounts
      this.state.markRemediation(legacyKey);
    }

    // 5) Recover low-inbox (non-blacklisted) senders: remove from ACTIVE campaigns + warmup + HOLD tag
    const threshold = this.config.remediationInboxThreshold;
    const holdDays = this.config.recoveryHoldDays;
    const holdUntilDate = addDaysIsoDate(new Date(), holdDays);
    let holdTag: { id: number; name: string } | null = null;
    const pendingHold: Array<{
      accountId: number;
      email: string;
      rate: number;
      heldAt: string;
    }> = [];

    const recoverCandidates = accounts.filter((account) => {
      const email = accountEmail(account)?.toLowerCase();
      const domain = accountDomain(account);
      if (!email || !domain) return false;
      if (blacklistedSet.has(domain)) return false;
      const rate = inboxRates.get(email);
      if (rate === undefined) return false;
      return rate < threshold;
    });

    for (const account of recoverCandidates) {
      const email = accountEmail(account)!;
      const rate = inboxRates.get(email.toLowerCase())!;
      const key = `remediate-inbox:${email.toLowerCase()}`;
      if (this.state.hasRemediation(key)) continue;

      const campaignIds = campaignIdsOf(account).filter((id) => {
        const status = campaignStatus.get(id);
        return !status || status === "ACTIVE";
      });

      const removedFrom: number[] = [];
      let removeFailures = 0;
      for (const campaignId of campaignIds) {
        try {
          if (!result.dryRun) {
            // If this is the last account on an ACTIVE campaign, pause first.
            const onCampaign = await this.smartlead.getCampaignEmailAccounts(
              campaignId,
            );
            if (!onCampaign.some((a) => a.id === account.id)) {
              // Already off this campaign (prior partial run)
              removedFrom.push(campaignId);
              continue;
            }
            const remainingOthers = onCampaign.filter((a) => a.id !== account.id);
            if (remainingOthers.length === 0) {
              const pauseKey = `remediate-pause-campaign:${campaignId}`;
              if (!this.state.hasRemediation(pauseKey)) {
                await this.smartlead.updateCampaignStatus(campaignId, "PAUSED");
                this.state.markRemediation(pauseKey);
                result.pausedCampaigns.push(campaignId);
              }
            }
            await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
              account.id,
            ]);
            await sleep(350);
          }
          removedFrom.push(campaignId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          removeFailures += 1;
          // If API rejects removing last account, try pause then remove
          if (
            !result.dryRun &&
            error instanceof ApiError &&
            /all accounts|at least one/i.test(message)
          ) {
            try {
              await this.smartlead.updateCampaignStatus(campaignId, "PAUSED");
              result.pausedCampaigns.push(campaignId);
              await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
                account.id,
              ]);
              removedFrom.push(campaignId);
              removeFailures -= 1;
              continue;
            } catch (inner) {
              const innerMsg =
                inner instanceof Error ? inner.message : String(inner);
              result.errors.push(
                `remove ${email} from campaign ${campaignId}: ${innerMsg}`,
              );
              continue;
            }
          }
          result.errors.push(
            `remove ${email} from campaign ${campaignId}: ${message}`,
          );
        }
      }

      let warmupOk = result.dryRun;
      try {
        if (!result.dryRun) {
          await this.smartlead.configureWarmup(account.id, {
            warmup_enabled: true,
            total_warmup_per_day: this.config.warmupTotalPerDay,
            daily_rampup: this.config.warmupDailyRampup,
            reply_rate_percentage: this.config.warmupReplyRatePercentage,
          });
          await sleep(250);
        }
        warmupOk = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`warmup ${email}: ${message}`);
      }

      // Only record + dedupe when we actually recovered (warmup on) or removed from campaigns.
      // Leave incomplete work unmarked so a later run can retry after rate limits.
      if (!warmupOk && removedFrom.length === 0 && !result.dryRun) {
        continue;
      }

      let tagName: string | undefined;
      if (warmupOk) {
        try {
          if (!result.dryRun) {
            if (!holdTag) {
              holdTag = await this.smartlead.ensureHoldUntilTag(holdUntilDate);
            }
            pendingHold.push({
              accountId: account.id,
              email,
              rate,
              heldAt: new Date().toISOString(),
            });
            tagName = holdTag.name;
          } else {
            tagName = `HOLD-UNTIL-${holdUntilDate}`;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`hold-tag ${email}: ${message}`);
        }
      }

      result.recoveredInboxes.push({
        id: account.id,
        email,
        inboxRate: rate,
        removedFromCampaigns: removedFrom,
        holdUntil: holdUntilDate,
        tagName,
        warmupEnabled: warmupOk,
      });

      if (warmupOk && removeFailures === 0) {
        this.state.markRemediation(key);
      } else if (warmupOk) {
        // Warmup on, but some campaign removals failed — mark so we don't keep re-warming;
        // leave a soft error for visibility.
        this.state.markRemediation(key);
      }
    }

    // Backfill HOLD tags for previously recovered inboxes that never got tagged
    await this.backfillHoldTags({
      accounts,
      result,
      holdDays,
      alreadyQueued: new Set(pendingHold.map((p) => p.accountId)),
    });

    // Flush tag assignments in batches of 25
    if (!result.dryRun && pendingHold.length && holdTag) {
      for (const batch of chunkIds(
        pendingHold.map((p) => p.accountId),
        25,
      )) {
        try {
          await this.smartlead.assignTags(batch, [holdTag.id]);
          result.holdTagged += batch.length;
          const batchSet = new Set(batch);
          for (const row of pendingHold) {
            if (!batchSet.has(row.accountId)) continue;
            this.state.markHeldInbox({
              accountId: row.accountId,
              email: row.email,
              heldAt: row.heldAt,
              holdUntil: holdUntilDate,
              tagName: holdTag.name,
              inboxRate: row.rate,
            });
          }
          await sleep(300);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`assign HOLD tag batch: ${message}`);
        }
      }
    } else if (result.dryRun) {
      result.holdTagged += pendingHold.length;
    }

    await this.finish(result);
    return result;
  }

  private async backfillHoldTags(opts: {
    accounts: SmartleadAccountWithCampaigns[];
    result: RemediationResult;
    holdDays: number;
    alreadyQueued: Set<number>;
  }): Promise<void> {
    const { accounts, result, holdDays, alreadyQueued } = opts;
    const byEmail = new Map(
      accounts
        .map((a) => [accountEmail(a)?.toLowerCase(), a] as const)
        .filter((x): x is [string, SmartleadAccountWithCampaigns] => Boolean(x[0])),
    );

    // From state remediations that lack a heldInboxes record
    const missing: Array<{ accountId: number; email: string; heldAt: string }> = [];
    for (const [key, heldAt] of Object.entries(this.state.get().remediatedKeys)) {
      if (!key.startsWith("remediate-inbox:")) continue;
      const email = key.slice("remediate-inbox:".length);
      if (this.state.getHeldInbox(email)) continue;
      const account = byEmail.get(email);
      if (!account) continue;
      if (alreadyQueued.has(account.id)) continue;
      missing.push({ accountId: account.id, email, heldAt });
    }

    if (!missing.length) return;

    // Group by hold-until date derived from original pull time
    const byHoldDate = new Map<string, typeof missing>();
    for (const row of missing) {
      const base = new Date(row.heldAt);
      const holdUntil = addDaysIsoDate(
        Number.isNaN(base.getTime()) ? new Date() : base,
        holdDays,
      );
      const list = byHoldDate.get(holdUntil) ?? [];
      list.push(row);
      byHoldDate.set(holdUntil, list);
    }

    for (const [holdUntil, rows] of byHoldDate) {
      let tag: { id: number; name: string };
      try {
        if (result.dryRun) {
          tag = { id: 0, name: `HOLD-UNTIL-${holdUntil}` };
        } else {
          tag = await this.smartlead.ensureHoldUntilTag(holdUntil);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`backfill hold-tag ${holdUntil}: ${message}`);
        continue;
      }

      const ids: number[] = [];
      for (const row of rows) {
        ids.push(row.accountId);
      }

      if (result.dryRun) {
        for (const row of rows) {
          this.state.markHeldInbox({
            accountId: row.accountId,
            email: row.email,
            heldAt: row.heldAt,
            holdUntil,
            tagName: tag.name,
          });
        }
        result.holdTagged += ids.length;
        continue;
      }

      for (const batch of chunkIds(ids, 25)) {
        try {
          await this.smartlead.assignTags(batch, [tag.id]);
          result.holdTagged += batch.length;
          const batchSet = new Set(batch);
          for (const row of rows) {
            if (!batchSet.has(row.accountId)) continue;
            this.state.markHeldInbox({
              accountId: row.accountId,
              email: row.email,
              heldAt: row.heldAt,
              holdUntil,
              tagName: tag.name,
            });
          }
          await sleep(300);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`backfill assign HOLD tag: ${message}`);
        }
      }
    }
  }

  private async finish(result: RemediationResult): Promise<void> {
    await this.state.save();
    console.log("[remediation] Done", {
      dryRun: result.dryRun,
      blacklistedDomains: result.blacklistedDomains.length,
      deletedAccounts: result.deletedSmartleadAccounts.length,
      purgedInboxKit: result.purgedInboxKitDomains.length,
      recoveredInboxes: result.recoveredInboxes.length,
      holdTagged: result.holdTagged,
      pausedCampaigns: result.pausedCampaigns.length,
      errors: result.errors.length,
    });

    const acted =
      result.deletedSmartleadAccounts.length > 0 ||
      result.purgedInboxKitDomains.length > 0 ||
      result.recoveredInboxes.length > 0 ||
      result.blacklistedDomains.length > 0 ||
      result.holdTagged > 0;

    if (acted || result.errors.length) {
      await this.slack.notifyRemediation(result).catch((error) => {
        console.error("[remediation] Slack notify failed", error);
      });
    }
  }
}

/** YYYY-MM-DD in UTC, N days from base. */
export function addDaysIsoDate(base: Date, days: number): string {
  const d = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function chunkIds(ids: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
