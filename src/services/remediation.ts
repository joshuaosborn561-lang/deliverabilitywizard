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
  }>;
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
      const key = `remediate-domain:${domain}`;
      if (this.state.hasRemediation(key)) continue;

      const domainAccounts = accounts.filter(
        (a) => accountDomain(a) === domain,
      );

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

      if (this.inboxkit) {
        try {
          if (!result.dryRun) {
            await this.inboxkit.purgeDomain(domain);
          }
          result.purgedInboxKitDomains.push(domain);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`InboxKit purge ${domain}: ${message}`);
        }
      } else {
        result.errors.push(
          `InboxKit not configured — skipped purge for ${domain}`,
        );
      }

      this.state.markRemediation(key);
    }

    // 5) Recover low-inbox (non-blacklisted) senders: remove from ACTIVE campaigns + warmup
    const threshold = this.config.remediationInboxThreshold;
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
      for (const campaignId of campaignIds) {
        try {
          if (!result.dryRun) {
            // If this is the last account on an ACTIVE campaign, pause first.
            const onCampaign = await this.smartlead.getCampaignEmailAccounts(
              campaignId,
            );
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
            await sleep(150);
          }
          removedFrom.push(campaignId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
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

      try {
        if (!result.dryRun) {
          await this.smartlead.configureWarmup(account.id, {
            warmup_enabled: true,
            total_warmup_per_day: this.config.warmupTotalPerDay,
            daily_rampup: this.config.warmupDailyRampup,
            reply_rate_percentage: this.config.warmupReplyRatePercentage,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`warmup ${email}: ${message}`);
      }

      result.recoveredInboxes.push({
        id: account.id,
        email,
        inboxRate: rate,
        removedFromCampaigns: removedFrom,
      });
      this.state.markRemediation(key);
    }

    await this.finish(result);
    return result;
  }

  private async finish(result: RemediationResult): Promise<void> {
    await this.state.save();
    console.log("[remediation] Done", {
      dryRun: result.dryRun,
      blacklistedDomains: result.blacklistedDomains.length,
      deletedAccounts: result.deletedSmartleadAccounts.length,
      purgedInboxKit: result.purgedInboxKitDomains.length,
      recoveredInboxes: result.recoveredInboxes.length,
      pausedCampaigns: result.pausedCampaigns.length,
      errors: result.errors.length,
    });

    const acted =
      result.deletedSmartleadAccounts.length > 0 ||
      result.purgedInboxKitDomains.length > 0 ||
      result.recoveredInboxes.length > 0 ||
      result.blacklistedDomains.length > 0;

    if (acted || result.errors.length) {
      await this.slack.notifyRemediation(result).catch((error) => {
        console.error("[remediation] Slack notify failed", error);
      });
    }
  }
}
