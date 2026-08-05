import type { AppConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  normalizeTestList,
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  parseSenderInboxRates,
  uniqueBlacklistedDomains,
  type SenderInboxRate,
} from "../clients/smartdelivery.js";
import { isBcpCampaignName, isBcpOwnedDomain } from "../lib/bcp.js";
import { filterTeardownBlacklistHits } from "../lib/blacklistDiagnosis.js";
import { prioritizeTestIdsForReports } from "../lib/testIdPriority.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountDomain,
  accountEmail,
  campaignIdsOf,
  resolveAccountClient,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { isRateLimitNoise } from "../lib/alertNoise.js";
import { ApiError, sleep } from "../lib/http.js";
import type {
  SpendDecision,
  SpendGateway,
  SpendRequest,
} from "../lib/spendGateway.js";
import type { StateStore } from "../state/store.js";
import {
  RecoveryPoolService,
  type RecoveryPoolResult,
} from "./recoveryPool.js";
import {
  parseSenderBounceStats,
  shouldRotateForBounces,
} from "../lib/bounceRate.js";

export interface ClientBackfillAction {
  clientId: number | null;
  clientName: string;
  domainsToReplace: string[];
  inboxesToReplace: number;
  sampleEmails: string[];
  holdUntil?: string;
  affectedCampaignIds: number[];
  pausedCampaignIds: number[];
}

export interface RestoredInbox {
  id: number;
  email: string;
  inboxRate: number;
  inboxRateAll?: number;
  reattachedCampaignIds: number[];
  holdTagRemoved?: boolean;
  clientId?: number | null;
  clientName?: string;
  reason: string;
}

export interface SameEspAuditResult {
  dryRun: boolean;
  scoredSenders: number;
  falseHoldsFound: number;
  restored: RestoredInbox[];
  stillHeldBelowThreshold: number;
  skippedLowSamples: number;
  errors: string[];
}

export interface RemediationResult {
  blacklistedDomains: string[];
  deletedSmartleadAccounts: Array<{
    id: number;
    email: string;
    domain: string;
    clientId?: number | null;
    clientName?: string;
  }>;
  purgedInboxKitDomains: string[];
  recoveredInboxes: Array<{
    id: number;
    email: string;
    inboxRate: number;
    inboxRateAll?: number;
    scoredSameEsp?: boolean;
    removedFromCampaigns: number[];
    holdUntil?: string;
    tagName?: string;
    warmupEnabled?: boolean;
    clientId?: number | null;
    clientName?: string;
  }>;
  sameEspAudit?: SameEspAuditResult;
  recoveryPool?: RecoveryPoolResult;
  clientActions: ClientBackfillAction[];
  holdTagged: number;
  pausedCampaigns: number[];
  errors: string[];
  dryRun: boolean;
}

export class RemediationService {
  private readonly recoveryPool: RecoveryPoolService;

  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly inboxkit: InboxKitClient | null,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly spendGateway: SpendGateway,
  ) {
    this.recoveryPool = new RecoveryPoolService(
      config,
      smartlead,
      slack,
      state,
    );
  }

  async run(): Promise<RemediationResult> {
    const result: RemediationResult = {
      blacklistedDomains: [],
      deletedSmartleadAccounts: [],
      purgedInboxKitDomains: [],
      recoveredInboxes: [],
      clientActions: [],
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
      `[remediation] Starting (${result.dryRun ? "DRY RUN" : "LIVE"}; same-ESP=${this.config.scoreSameEspOnly})`,
    );

    const trackedIds = [
      ...new Set(
        Object.values(this.state.get().testedCampaigns).flatMap((c) => c.testIds),
      ),
    ];
    // Prefer ACTIVE automated tests over old COMPLETED manuals — a hard
    // insertion-order slice(0,40) previously dropped entire live campaigns.
    const listedTests = await this.smartDelivery
      .listTests({})
      .then((raw) => normalizeTestList(raw))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`list tests for report priority: ${message}`);
        return [];
      });
    const testIds = prioritizeTestIdsForReports({
      trackedIds,
      listedTests,
    });
    console.log(
      `[remediation] Using ${testIds.length}/${trackedIds.length} tracked test id(s) for reports (ACTIVE autos first)`,
    );

    // 1) Load Smartlead accounts (needed for ESP type → same-ESP scoring)
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

    const senderTypeByEmail = new Map<string, string | undefined>();
    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (email) senderTypeByEmail.set(email, account.type);
    }

    // 2) Collect blacklisted sending domains from SmartDelivery reports
    const blacklistHits = [];
    for (const testId of testIds) {
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
    // SURBL / unnamed SmartDelivery domain-blacklist flags are noise for
    // teardown — keep them out of the delete path (Josh: omit SURBL domains).
    const teardownHits = filterTeardownBlacklistHits(blacklistHits);
    const ignoredForTeardown = uniqueBlacklistedDomains(blacklistHits).filter(
      (domain) =>
        !uniqueBlacklistedDomains(teardownHits)
          .map((d) => d.toLowerCase())
          .includes(domain.toLowerCase()),
    );
    if (ignoredForTeardown.length) {
      console.log(
        `[remediation] Ignoring SURBL/unnamed domain-blacklist hit(s) for teardown: ${ignoredForTeardown.join(", ")}`,
      );
    }
    const blacklistedDomains = uniqueBlacklistedDomains(teardownHits).map((d) =>
      d.toLowerCase(),
    );
    // Historical SmartDelivery tests keep reporting purged domains forever.
    // Only treat a blacklist as actionable if accounts still exist or we have
    // not finished remediation yet — otherwise Slack would spam every cron.
    const actionableBlacklistedDomains = blacklistedDomains.filter((domain) => {
      const stillHasAccounts = accounts.some(
        (a) => accountDomain(a) === domain,
      );
      const alreadyDone =
        this.state.hasRemediation(`remediate-domain-sl:${domain}`) ||
        this.state.hasRemediation(`remediate-domain:${domain}`);
      return stillHasAccounts || !alreadyDone;
    });
    result.blacklistedDomains = actionableBlacklistedDomains;
    // Skip low-inbox recovery only for domains headed to teardown — SURBL /
    // unnamed hits are ignored for delete, so those senders can still be
    // benched + swapped on inbox rate (D5).
    const blacklistedSet = new Set(actionableBlacklistedDomains);
    if (blacklistedDomains.length && !actionableBlacklistedDomains.length) {
      console.log(
        `[remediation] Ignoring ${blacklistedDomains.length} historical blacklist hit(s) already remediated with no remaining accounts: ${blacklistedDomains.join(", ")}`,
      );
    }

    // 3) Collect per-sender inbox rates (same-ESP when ESP matching is on)
    const inboxRateRows = new Map<string, SenderInboxRate>();
    for (const testId of testIds) {
      try {
        const raw = await this.smartDelivery.getSenderAccountReport(testId);
        for (const row of parseSenderInboxRates(raw, testId, {
          senderTypeByEmail,
          preferSameEsp: this.config.scoreSameEspOnly,
          minSameEspSamples: this.config.minSameEspSamples,
        })) {
          const key = row.email.toLowerCase();
          const prev = inboxRateRows.get(key);
          // Keep the worst (lowest) observed decision rate
          if (prev === undefined || row.inboxRate < prev.inboxRate) {
            inboxRateRows.set(key, row);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`sender report ${testId}: ${message}`);
      }
    }

    // Mailbox-summary is blended across ESPs — skip when scoring same-ESP only.
    if (!this.config.scoreSameEspOnly) {
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
            const prev = inboxRateRows.get(email);
            if (prev === undefined || score < prev.inboxRate) {
              inboxRateRows.set(email, {
                email,
                inboxRate: score,
                scoredSameEsp: false,
              });
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`mailbox-summary: ${message}`);
      }
    }

    const inboxRates = new Map<string, number>(
      [...inboxRateRows.entries()].map(([k, v]) => [k, v.inboxRate]),
    );

    // 3b) Undo prior pulls that fail the same-ESP audit (blended false positives)
    result.sameEspAudit = await this.auditAndRestoreFalseHolds({
      accounts,
      inboxRateRows,
      dryRun: result.dryRun,
    });
    result.errors.push(...result.sameEspAudit.errors);

    // Index campaigns for status + client ownership
    let campaignStatus = new Map<number, string>();
    let campaignNameById = new Map<number, string>();
    let campaignClientById = new Map<number, number | null | undefined>();
    let clientsById = new Map<number, SmartleadClientRecord>();
    try {
      const [campaigns, clients] = await Promise.all([
        this.smartlead.listCampaigns(),
        this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      ]);
      campaignStatus = new Map(
        campaigns.map((c) => [c.id, String(c.status || "").toUpperCase()]),
      );
      campaignNameById = new Map(
        campaigns.map((c) => [c.id, String(c.name ?? "")]),
      );
      campaignClientById = new Map(
        campaigns.map((c) => [c.id, c.client_id ?? null]),
      );
      clientsById = new Map(clients.map((c) => [c.id, c]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list campaigns/clients: ${message}`);
    }

    const accountClient = (account: SmartleadAccountWithCampaigns) =>
      resolveAccountClient(account, campaignClientById, clientsById);

    // 4) Delete blacklisted domains from Smartlead + InboxKit
    for (const domain of actionableBlacklistedDomains) {
      const slKey = `remediate-domain-sl:${domain}`;
      const ikKey = `remediate-domain-ik:${domain}`;
      // Back-compat with older single-key dedupe
      const legacyKey = `remediate-domain:${domain}`;

      const domainAccounts = accounts.filter(
        (a) => accountDomain(a) === domain,
      );
      let teardownSpend:
        | { decision: SpendDecision; request: SpendRequest }
        | undefined;
      let teardownFailed = false;

      // Deleting mailboxes and purging a domain destroys paid assets and forces
      // re-buying replacements — hold it for explicit human approval.
      if (!result.dryRun) {
        const request: SpendRequest = {
          key: `teardown-domain:${domain}`,
          scope: "destructive",
          kind: "blacklisted_domain_teardown",
          description: `Delete ${domainAccounts.length} Smartlead mailbox(es) on blacklisted domain ${domain} and purge the domain from InboxKit. Replacement domain + mailboxes will need to be bought.`,
          detail: {
            domain,
            smartleadAccounts: domainAccounts.length,
            sampleEmails: domainAccounts
              .slice(0, 5)
              .map((a) => accountEmail(a) || `id:${a.id}`),
          },
        };
        const decision = await this.spendGateway.authorize(request);
        if (!decision.approved) {
          result.errors.push(
            `${domain}: teardown awaiting approval (${decision.record.status}) — see GET /approvals`,
          );
          continue;
        }
        teardownSpend = { decision, request };
      }

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
              ...accountClient(account),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            teardownFailed = true;
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
            teardownFailed = true;
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
          teardownFailed = true;
          result.errors.push(
            `InboxKit not configured — skipped purge for ${domain}`,
          );
        }
      }

      // Keep legacy key so older monitors don't re-delete Smartlead accounts
      this.state.markRemediation(legacyKey);
      if (teardownSpend && !teardownFailed) {
        await this.spendGateway.consume(
          teardownSpend.decision,
          teardownSpend.request,
        );
      }
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
      removedFromCampaigns?: number[];
      inboxRateAll?: number;
      scoredSameEsp?: boolean;
    }> = [];

    // A sender can hold a clean inbox rate while bouncing hard against real
    // leads — seed inboxes accept mail, so a placement test never sees it.
    // Bounce is an independent signal, routed through the same hold-and-swap
    // path as poor placement so a warmed generic takes over either way.
    const bounceRotations = new Map<string, number>();
    if (this.config.enableBounceRotation) {
      try {
        const stats = parseSenderBounceStats(
          await this.smartlead.getMailboxHealthMetrics(),
        );
        console.log(`[remediation] bounce stats parsed for ${stats.length} sender(s)`);
        for (const stat of stats) {
          if (
            shouldRotateForBounces(
              stat,
              this.config.bounceRateThreshold,
              this.config.minBounceSample,
            )
          ) {
            bounceRotations.set(stat.email, stat.bounceRate);
          }
        }
        if (bounceRotations.size) {
          console.log(
            `[remediation] ${bounceRotations.size} sender(s) over ${this.config.bounceRateThreshold}% bounce:`,
            [...bounceRotations.entries()]
              .slice(0, 20)
              .map(([e, r]) => `${e} ${r.toFixed(1)}%`),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`bounce stats: ${message}`);
        console.warn(`[remediation] bounce stats unavailable: ${message}`);
      }
    }

    const recoverCandidates = accounts.filter((account) => {
      const email = accountEmail(account)?.toLowerCase();
      const domain = accountDomain(account);
      if (!email || !domain) return false;
      if (blacklistedSet.has(domain)) return false;
      // BCP is client-domain only while ramping — do not bench/swap generics in.
      if (isBcpOwnedDomain(domain)) return false;
      const onBcpOnly = campaignIdsOf(account)
        .filter((id) => {
          const status = campaignStatus.get(id);
          return !status || status === "ACTIVE";
        })
        .every((id) => isBcpCampaignName(campaignNameById.get(id) ?? ""));
      if (onBcpOnly && campaignIdsOf(account).length > 0) return false;
      // High bounce is disqualifying on its own, regardless of placement.
      if (bounceRotations.has(email)) return true;
      const rate = inboxRates.get(email);
      if (rate === undefined) return false;
      return rate < threshold;
    });

    for (const account of recoverCandidates) {
      const email = accountEmail(account)!;
      const rateRow = inboxRateRows.get(email.toLowerCase());
      const rate = inboxRates.get(email.toLowerCase())!;
      const key = `remediate-inbox:${email.toLowerCase()}`;
      if (this.state.hasRemediation(key)) continue;
      if (this.state.getHeldInbox(email)) continue;

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
              removedFromCampaigns: [],
              inboxRateAll: rateRow?.inboxRateAll,
              scoredSameEsp: rateRow?.scoredSameEsp,
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
        inboxRateAll: rateRow?.inboxRateAll,
        scoredSameEsp: rateRow?.scoredSameEsp,
        removedFromCampaigns: removedFrom,
        holdUntil: holdUntilDate,
        tagName,
        warmupEnabled: warmupOk,
        ...accountClient(account),
      });

      const pending = pendingHold.find((p) => p.accountId === account.id);
      if (pending) pending.removedFromCampaigns = removedFrom;

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
              inboxRateAll: row.inboxRateAll,
              scoredSameEsp: row.scoredSameEsp,
              removedFromCampaigns: row.removedFromCampaigns,
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

    // 6) Recovery pool: restore healthy originals that were covered by generics,
    //    then swap generics into newly held campaign slots (ESP-matched).
    if (this.config.enableRecoveryPool) {
      const recoveredOriginals: Array<{ email: string; inboxRate: number }> =
        [];
      for (const swap of this.state.listActiveSwaps()) {
        const rateRow = inboxRateRows.get(swap.originalEmail.toLowerCase());
        if (!rateRow) continue;
        const rate =
          typeof rateRow.inboxRateSameEsp === "number" &&
          (rateRow.sameEspSamples ?? 0) >= this.config.minSameEspSamples
            ? rateRow.inboxRateSameEsp
            : rateRow.inboxRate;
        if (rate >= threshold) {
          recoveredOriginals.push({
            email: swap.originalEmail,
            inboxRate: rate,
          });
        }
      }

      const byId = new Map(accounts.map((a) => [a.id, a]));
      result.recoveryPool = await this.recoveryPool.run({
        accounts,
        newlyHeld: result.recoveredInboxes.map((r) => {
          const acc = byId.get(r.id);
          return {
            accountId: r.id,
            email: r.email,
            removedFromCampaigns: r.removedFromCampaigns,
            clientId: r.clientId,
            clientName: r.clientName,
            type: acc?.type,
            fromName: acc?.from_name,
          };
        }),
        recoveredOriginals,
        dryRun: result.dryRun,
        campaignClientById,
        clientsById,
      });
      result.errors.push(...result.recoveryPool.errors);
    }

    result.clientActions = buildClientBackfillActions(result);
    await this.finish(result);
    return result;
  }

  /**
   * Re-score held inboxes with same-ESP rules and restore any that were
   * pulled only because cross-ESP (blended) scores looked bad.
   */
  async auditAndRestoreFalseHolds(opts: {
    accounts: SmartleadAccountWithCampaigns[];
    inboxRateRows: Map<string, SenderInboxRate>;
    dryRun: boolean;
  }): Promise<SameEspAuditResult> {
    const out: SameEspAuditResult = {
      dryRun: opts.dryRun,
      scoredSenders: opts.inboxRateRows.size,
      falseHoldsFound: 0,
      restored: [],
      stillHeldBelowThreshold: 0,
      skippedLowSamples: 0,
      errors: [],
    };

    if (!this.config.scoreSameEspOnly) return out;

    const threshold = this.config.remediationInboxThreshold;
    const minSame = this.config.minSameEspSamples;
    const byEmail = new Map(
      opts.accounts
        .map((a) => [accountEmail(a)?.toLowerCase(), a] as const)
        .filter((x): x is [string, SmartleadAccountWithCampaigns] => Boolean(x[0])),
    );

    // Index ACTIVE/PAUSED campaigns by client and by domain currently on them
    let campaigns: Awaited<ReturnType<SmartleadClient["listCampaigns"]>> = [];
    try {
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out.errors.push(`audit list campaigns: ${message}`);
      return out;
    }

    const attachable = campaigns.filter((c) =>
      ["ACTIVE", "PAUSED"].includes(String(c.status ?? "").toUpperCase()),
    );
    const domainToCampaignIds = new Map<string, number[]>();
    for (const campaign of attachable) {
      try {
        const onCampaign = await this.smartlead.getCampaignEmailAccounts(
          campaign.id,
        );
        for (const account of onCampaign) {
          const domain = accountDomain(account);
          if (!domain) continue;
          const list = domainToCampaignIds.get(domain) ?? [];
          if (!list.includes(campaign.id)) list.push(campaign.id);
          domainToCampaignIds.set(domain, list);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.errors.push(`audit campaign accounts ${campaign.id}: ${message}`);
      }
      await sleep(120);
    }

    let clientsById = new Map<number, SmartleadClientRecord>();
    let campaignClientById = new Map<number, number | null | undefined>();
    try {
      const clients = await this.smartlead.listClients();
      clientsById = new Map(clients.map((c) => [c.id, c]));
      for (const c of campaigns) {
        campaignClientById.set(c.id, c.client_id);
      }
    } catch {
      // non-fatal for restore labeling
    }

    // Resolve HOLD tag id(s) once
    let holdTags: Array<{ id: number; name: string }> = [];
    try {
      const tags = await this.smartlead.listTags();
      holdTags = tags.filter((t) =>
        /^HOLD-UNTIL-/i.test(String(t.name ?? "")),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out.errors.push(`audit list tags: ${message}`);
    }

    const held = this.state.listHeldInboxes();
    for (const record of held) {
      const email = record.email.toLowerCase();
      // Active pool swap — RecoveryPoolService restores these when healthy
      if (this.state.getSwap(email)) continue;
      const row = opts.inboxRateRows.get(email);
      if (!row) continue;

      const sameSamples = row.sameEspSamples ?? 0;
      const sameRate = row.inboxRateSameEsp;
      const allRate = row.inboxRateAll ?? row.inboxRate;

      if (typeof sameRate !== "number" || sameSamples < minSame) {
        out.skippedLowSamples += 1;
        // Fall back: if decision rate (possibly blended) is still bad, count as held-bad
        if (row.inboxRate < threshold) out.stillHeldBelowThreshold += 1;
        continue;
      }

      // Held but same-ESP is healthy → restore (prior blended-score false positive)
      if (sameRate < threshold) {
        out.stillHeldBelowThreshold += 1;
        continue;
      }

      out.falseHoldsFound += 1;
      const account = byEmail.get(email);
      if (!account) {
        out.errors.push(`audit restore ${email}: account not found`);
        continue;
      }

      const client = resolveAccountClient(
        account,
        campaignClientById,
        clientsById,
      );
      const domain = accountDomain(account);
      const targetCampaigns = new Set<number>(
        record.removedFromCampaigns ?? [],
      );
      // Only reattach where the same sending domain is already present on an
      // ACTIVE/PAUSED campaign — never dump onto every campaign for the client.
      if (domain) {
        for (const id of domainToCampaignIds.get(domain) ?? []) {
          targetCampaigns.add(id);
        }
      }
      // Keep if the account is still linked to an attachable campaign in Smartlead
      for (const id of campaignIdsOf(account)) {
        const camp = attachable.find((c) => c.id === id);
        if (camp) targetCampaigns.add(id);
      }

      const reattached: number[] = [];
      let holdTagRemoved = false;

      try {
        if (!opts.dryRun) {
          const tagIds = new Set<number>();
          for (const t of holdTags) tagIds.add(t.id);
          for (const t of account.tags ?? []) {
            const id = t.tag_id ?? t.id;
            const name = t.tag_name ?? t.name ?? "";
            if (typeof id === "number" && /^HOLD-UNTIL-/i.test(name)) {
              tagIds.add(id);
            }
          }
          if (tagIds.size) {
            await this.smartlead.removeTags(account.id ? [account.id] : [], [
              ...tagIds,
            ]);
            holdTagRemoved = true;
            await sleep(250);
          }

          for (const campaignId of targetCampaigns) {
            try {
              const onCampaign =
                await this.smartlead.getCampaignEmailAccounts(campaignId);
              if (onCampaign.some((a) => a.id === account.id)) {
                reattached.push(campaignId);
                continue;
              }
              await this.smartlead.addEmailAccountsToCampaign(campaignId, [
                account.id,
              ]);
              reattached.push(campaignId);
              await sleep(350);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              out.errors.push(
                `reattach ${email} → campaign ${campaignId}: ${message}`,
              );
            }
          }

          this.state.clearHeldInbox(email);
          this.state.clearInboxRemediation(email);
        } else {
          holdTagRemoved = true;
          reattached.push(...targetCampaigns);
        }

        out.restored.push({
          id: account.id,
          email,
          inboxRate: sameRate,
          inboxRateAll: allRate,
          reattachedCampaignIds: reattached,
          holdTagRemoved,
          clientId: client.clientId,
          clientName: client.clientName,
          reason: `same-ESP ${sameRate.toFixed(1)}% (≥${threshold}%) over ${sameSamples} seeds; blended was ${
            typeof allRate === "number" ? `${allRate.toFixed(1)}%` : "n/a"
          }`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.errors.push(`audit restore ${email}: ${message}`);
      }
    }

    console.log("[remediation] same-ESP audit", {
      falseHoldsFound: out.falseHoldsFound,
      restored: out.restored.length,
      stillHeldBelowThreshold: out.stillHeldBelowThreshold,
      errors: out.errors.length,
    });

    return out;
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
      poolSwaps: result.recoveryPool?.swaps.length ?? 0,
      poolRestores: result.recoveryPool?.restores.length ?? 0,
      clientActions: result.clientActions.length,
      pausedCampaigns: result.pausedCampaigns.length,
      errors: result.errors.length,
    });

    const acted =
      result.deletedSmartleadAccounts.length > 0 ||
      result.purgedInboxKitDomains.length > 0 ||
      result.recoveredInboxes.length > 0 ||
      result.holdTagged > 0 ||
      result.clientActions.length > 0 ||
      (result.sameEspAudit?.restored.length ?? 0) > 0 ||
      (result.recoveryPool?.swaps.length ?? 0) > 0 ||
      (result.recoveryPool?.restores.length ?? 0) > 0;

    // Rate-limit noise alone should not page Slack
    const seriousErrors = result.errors.filter((e) => !isRateLimitNoise(e));

    if (acted || seriousErrors.length) {
      await this.slack.notifyRemediation({
        ...result,
        errors: seriousErrors,
      }).catch((error) => {
        console.error("[remediation] Slack notify failed", error);
      });
    } else if (result.errors.length) {
      console.log(
        `[remediation] Skipping Slack (no actions; ${result.errors.length} rate-limit/noise error(s))`,
      );
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

export function buildClientBackfillActions(
  result: Pick<
    RemediationResult,
    | "deletedSmartleadAccounts"
    | "purgedInboxKitDomains"
    | "recoveredInboxes"
    | "pausedCampaigns"
  >,
): ClientBackfillAction[] {
  type Acc = {
    clientId: number | null;
    clientName: string;
    domains: Set<string>;
    emails: string[];
    campaignIds: Set<number>;
    holdUntil?: string;
  };
  const byClient = new Map<string, Acc>();

  const bucket = (clientId: number | null | undefined, clientName?: string) => {
    const id = clientId ?? null;
    const name = clientName?.trim() || "Unassigned / Agency";
    const key = id == null ? `name:${name.toLowerCase()}` : `id:${id}`;
    let acc = byClient.get(key);
    if (!acc) {
      acc = {
        clientId: id,
        clientName: name,
        domains: new Set(),
        emails: [],
        campaignIds: new Set(),
      };
      byClient.set(key, acc);
    }
    return acc;
  };

  for (const row of result.deletedSmartleadAccounts) {
    const acc = bucket(row.clientId, row.clientName);
    acc.domains.add(row.domain.toLowerCase());
  }
  for (const domain of result.purgedInboxKitDomains) {
    // Prefer attaching purged domains to a client that already has that domain deleted
    const match = result.deletedSmartleadAccounts.find(
      (a) => a.domain.toLowerCase() === domain.toLowerCase(),
    );
    const acc = bucket(match?.clientId ?? null, match?.clientName);
    acc.domains.add(domain.toLowerCase());
  }
  for (const row of result.recoveredInboxes) {
    const acc = bucket(row.clientId, row.clientName);
    acc.emails.push(row.email);
    for (const campaignId of row.removedFromCampaigns) {
      acc.campaignIds.add(campaignId);
    }
    if (row.holdUntil) acc.holdUntil = row.holdUntil;
  }

  const paused = new Set(result.pausedCampaigns);
  return [...byClient.values()]
    .map((acc) => ({
      clientId: acc.clientId,
      clientName: acc.clientName,
      domainsToReplace: [...acc.domains].sort(),
      inboxesToReplace: acc.emails.length,
      sampleEmails: acc.emails.slice(0, 8),
      holdUntil: acc.holdUntil,
      affectedCampaignIds: [...acc.campaignIds].sort((a, b) => a - b),
      pausedCampaignIds: [...acc.campaignIds]
        .filter((id) => paused.has(id))
        .sort((a, b) => a - b),
    }))
    .filter((a) => a.domainsToReplace.length > 0 || a.inboxesToReplace > 0)
    .sort((a, b) => a.clientName.localeCompare(b.clientName));
}

function chunkIds(ids: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
