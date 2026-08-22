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
  campaignIdOf,
  testIdOf,
  type SenderInboxRate,
} from "../clients/smartdelivery.js";
import { filterTeardownBlacklistHits } from "../lib/blacklistDiagnosis.js";
import { burnChecklistReady } from "../lib/burnChecklist.js";
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
import { isBenignOpsNoise } from "../lib/alertNoise.js";
import { ApiError, sleep } from "../lib/http.js";
import {
  classifyCopySignal,
  shouldDeferSenderRotationForCopy,
  type ProviderInboxSplit,
} from "../lib/copySignal.js";
import type {
  SpendDecision,
  SpendGateway,
  SpendRequest,
} from "../lib/spendGateway.js";
import type { ProviderwiseRow } from "../types/index.js";
import type { StateStore } from "../state/store.js";
import {
  RecoveryPoolService,
  type RecoveryPoolResult,
} from "./recoveryPool.js";
import {
  parseSenderBounceStats,
  shouldRotateForBounces,
  shouldWarnForBounces,
} from "../lib/bounceRate.js";
import { classifyHoldOutcome } from "../lib/holdOutcome.js";
import { isMissingSpamTestNoise } from "../lib/alertNoise.js";
import { summarizeErrors } from "../lib/errorDigest.js";
import { activeHoldUntilDate, tagNames } from "./warmupGate.js";
import {
  preferSenderInboxRate,
  shouldRotateForPlacement,
} from "../lib/placementRotation.js";

function inboxPercentFromProvider(row: ProviderwiseRow): number | null {
  if (typeof row.inbox_rate === "number" && Number.isFinite(row.inbox_rate)) {
    return row.inbox_rate <= 1 ? row.inbox_rate * 100 : row.inbox_rate;
  }
  const inbox = row.inbox_count ?? 0;
  const tab = row.tab_count ?? 0;
  const spam = row.spam_count ?? 0;
  const total =
    row.adjusted_total_email_count ??
    row.total_email_count ??
    inbox + tab + spam;
  if (!total) return null;
  return (inbox / total) * 100;
}

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
  /** Absent when released for lack of same-ESP evidence rather than a score. */
  inboxRate?: number;
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
  /** Held, no usable same-ESP evidence, and not taken on a blended score. */
  noSameEspEvidence: number;
  /** Blended-score holds released because same-ESP never condemned them (D32). */
  unprovenBlendedReleased: number;
  /** Blended-score holds kept anyway because bounce still condemns them (D5). */
  heldOnBounce: number;
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
    /** Same-ESP inbox % — or the bounce % when `bounceDriven`. */
    inboxRate: number;
    inboxRateAll?: number;
    scoredSameEsp?: boolean;
    /** Pulled on bounce (D5) rather than placement, so `inboxRate` is bounce. */
    bounceDriven?: boolean;
    removedFromCampaigns: number[];
    holdUntil?: string;
    tagName?: string;
    warmupEnabled?: boolean;
    clientId?: number | null;
    clientName?: string;
  }>;
  sameEspAudit?: SameEspAuditResult;
  heldRelease?: HeldReleaseResult;
  heldReconcile?: HeldReconcileResult;
  recoveryPool?: RecoveryPoolResult;
  clientActions: ClientBackfillAction[];
  holdTagged: number;
  pausedCampaigns: number[];
  errors: string[];
  dryRun: boolean;
}

/** Holds that have served their D6 term and were let go. */
export interface HeldReleaseResult {
  dryRun: boolean;
  heldChecked: number;
  /** Served `RECOVERY_HOLD_DAYS` and released. */
  released: Array<{ email: string; heldDays: number; stampedUntil?: string }>;
  /** Served the term but still failing bounce — kept (D5). */
  keptOnBounce: number;
  /** Covered by an active pool swap; RecoveryPoolService owns those. */
  skippedActiveSwap: number;
  errors: string[];
}

/** Held mailboxes found still attached to ACTIVE campaigns, and re-pulled. */
export interface HeldReconcileResult {
  dryRun: boolean;
  heldChecked: number;
  stillActive: number;
  repulled: Array<{ email: string; campaignIds: number[] }>;
  /** Removals held back to keep a campaign at the D7 floor this pass. */
  deferredForFloor: number;
  errors: string[];
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

    // Test ids we still track that SmartDelivery has purged. Counted once at
    // the end rather than as per-test errors.
    const deadTestIds: string[] = [];

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
        if (isMissingSpamTestNoise(message)) {
          deadTestIds.push(testId);
          continue;
        }
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
    // A human-denied teardown (D15) is final: leave the domain in place and
    // do not keep it on the "headed to teardown" path every monitor pass.
    const deniedTeardownDomains = blacklistedDomains.filter((domain) =>
      isHumanDeniedTeardown(this.state, domain),
    );
    if (deniedTeardownDomains.length) {
      console.log(
        `[remediation] Honoring denied teardown approval(s); leaving domain(s) in place: ${deniedTeardownDomains.join(", ")}`,
      );
    }
    const actionableBlacklistedDomains = blacklistedDomains.filter((domain) => {
      if (deniedTeardownDomains.includes(domain)) return false;
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
          // D32: never let a blended row replace a same-ESP row; among equals
          // keep the worse inbox %.
          inboxRateRows.set(
            key,
            preferSenderInboxRate(prev, row, {
              scoreSameEspOnly: this.config.scoreSameEspOnly,
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Tracked ids outlive the SmartDelivery record (stopped/purged tests).
        // resultMonitor already skips these; remediation was still counting
        // them, which is most of what its error total has been reporting.
        if (isMissingSpamTestNoise(message)) {
          deadTestIds.push(testId);
          continue;
        }
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

    // A sender can hold a clean inbox rate while bouncing hard against real
    // leads — seed inboxes accept mail, so a placement test never sees it.
    // Bounce is an independent signal, routed through the same hold-and-swap
    // path as poor placement so a warmed generic takes over either way.
    //
    // Computed before the same-ESP audit because the audit needs it: a held
    // record does not record *why* it was held, so bounce is the only way to
    // tell a blended-placement hold from a bounce hold that happened to carry
    // a blended row.
    const bounceRotations = new Map<string, number>();
    const bounceByEmail = new Map<string, { bounceRate: number; sent: number }>();
    if (this.config.enableBounceRotation) {
      try {
        const stats = parseSenderBounceStats(
          await this.smartlead.getMailboxHealthMetrics(),
        );
        console.log(`[remediation] bounce stats parsed for ${stats.length} sender(s)`);
        const bounceWatches: Array<{ email: string; bounceRate: number; sent: number }> = [];
        for (const stat of stats) {
          bounceByEmail.set(stat.email, {
            bounceRate: stat.bounceRate,
            sent: stat.sent,
          });
          if (
            shouldRotateForBounces(
              stat,
              this.config.bounceRateThreshold,
              this.config.minBounceSample,
            )
          ) {
            bounceRotations.set(stat.email, stat.bounceRate);
          } else if (
            shouldWarnForBounces(
              stat,
              this.config.bounceRateWarnThreshold,
              this.config.bounceRateThreshold,
              this.config.minBounceSample,
            )
          ) {
            bounceWatches.push(stat);
          }
        }
        if (bounceWatches.length) {
          await this.notifyBounceWatch(bounceWatches);
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

    if (deadTestIds.length) {
      console.log(
        `[remediation] Skipped ${deadTestIds.length} tracked test id(s) SmartDelivery no longer has (not errors)`,
      );
    }

    // 3b) Undo prior pulls that fail the same-ESP audit (blended false positives)
    result.sameEspAudit = await this.auditAndRestoreFalseHolds({
      accounts,
      inboxRateRows,
      bounceRotations,
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

    this.refreshRestingScores(inboxRateRows);

    // 4) Delete blacklisted domains from Smartlead + InboxKit
    for (const domain of actionableBlacklistedDomains) {
      const slKey = `remediate-domain-sl:${domain}`;
      const ikKey = `remediate-domain-ik:${domain}`;
      // Back-compat with older single-key dedupe
      const legacyKey = `remediate-domain:${domain}`;

      const domainAccounts = accounts.filter(
        (a) => accountDomain(a) === domain,
      );
      const namedBlacklist = teardownHits.some(
        (hit) =>
          hit.domain.toLowerCase() === domain &&
          Boolean(hit.listName?.trim()) &&
          !/surbl|uribl|unnamed/i.test(hit.listName ?? ""),
      );
      const domainBounce = domainAccounts
        .map((a) => bounceByEmail.get((accountEmail(a) ?? "").toLowerCase()))
        .filter((s): s is { bounceRate: number; sent: number } => Boolean(s))
        .sort((a, b) => b.bounceRate - a.bounceRate)[0];
      const domainPlacement = domainAccounts
        .map((a) => inboxRateRows.get((accountEmail(a) ?? "").toLowerCase()))
        .filter((row): row is SenderInboxRate => Boolean(row))
        .sort((a, b) => a.inboxRate - b.inboxRate)[0];
      const checklist = burnChecklistReady({
        namedBlacklist,
        sameEspInbox: domainPlacement?.inboxRate ?? null,
        scoredSameEsp: domainPlacement?.scoredSameEsp,
        bounceRate: domainBounce?.bounceRate ?? null,
        sent: domainBounce?.sent ?? 0,
        inboxThreshold: this.config.remediationInboxThreshold,
        bounceThreshold: this.config.bounceRateThreshold,
        minBounceSample: this.config.minBounceSample,
      });
      if (!checklist.ready) {
        // D41: blacklist alone is not enough to burn. Log and skip — do not
        // push into result.errors (that used to page Slack / launch the
        // remediator). Classifier/alertNoise also treat leftover wording as
        // benign if it surfaces elsewhere.
        console.log(
          `[remediation] Burn checklist not ready for ${domain}: ${checklist.reasons.join("; ")} — blacklist alone is not enough`,
        );
        continue;
      }
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
          // Denied is a final human decision (D15) — log once per run, do not
          // treat as an error that pages Slack or launches the bug remediator.
          // Pending still surfaces so status/Slack can show the wait.
          const msg = `${domain}: teardown awaiting approval (${decision.record.status}) — see GET /approvals`;
          if (decision.record.status === "denied") {
            console.log(`[remediation] ${msg}`);
          } else {
            result.errors.push(msg);
          }
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
      inboxRateSameEsp?: number;
      scoredSameEsp?: boolean;
    }> = [];

    // D28: campaign → copy signal (from placement provider split). When
    // Outlook is spam-burying while Gmail is fine, defer sender rotation and
    // tell ops to test/fix the copy instead.
    const copyDeferByCampaign = new Map<number, string>();
    const listedForCopy = normalizeTestList(
      await this.smartDelivery.listTests({}).catch(() => []),
    );
    const enrichedForCopy = await this.smartDelivery
      .enrichCampaignIds(listedForCopy)
      .catch(() => listedForCopy);
    for (const test of enrichedForCopy) {
      const cid = Number(campaignIdOf(test));
      const tid = testIdOf(test);
      if (!cid || !tid || copyDeferByCampaign.has(cid)) continue;
      try {
        const report = await this.smartDelivery.getProviderwiseReport(tid);
        const providers: ProviderInboxSplit[] = [];
        for (const row of report.result ?? []) {
          const name = String(row.provider_name ?? row.provider ?? "");
          const inbox = inboxPercentFromProvider(row);
          if (!name || inbox == null) continue;
          providers.push({ name, inboxPercent: inbox });
        }
        const signal = classifyCopySignal(providers, threshold);
        if (shouldDeferSenderRotationForCopy(signal)) {
          copyDeferByCampaign.set(cid, signal.reason);
        }
      } catch {
        // Placement copy signal is best-effort; bounce path still runs.
      }
    }
    if (copyDeferByCampaign.size) {
      const lines = [
        "Low inbox looks like *copy/offer* filtering (not a single mailbox). Holding sender rotation — test/fix the campaign copy:",
        ...[...copyDeferByCampaign.entries()].map(
          ([id, reason]) =>
            `• #${id} ${campaignNameById.get(id) ?? id}: ${reason}`,
        ),
      ];
      try {
        await this.slack.send(lines.join("\n"));
      } catch (error) {
        console.warn("[remediation] copy-signal Slack failed", error);
      }
    }

    const recoverCandidates = accounts.filter((account) => {
      const email = accountEmail(account)?.toLowerCase();
      const domain = accountDomain(account);
      if (!email || !domain) return false;
      if (blacklistedSet.has(domain)) return false;
      // High bounce is disqualifying on its own, regardless of placement.
      if (bounceRotations.has(email)) return true;
      // D32: placement rotation requires a same-ESP score — never blended.
      return shouldRotateForPlacement(inboxRateRows.get(email), threshold, {
        scoreSameEspOnly: this.config.scoreSameEspOnly,
      });
    });

    for (const account of recoverCandidates) {
      const email = accountEmail(account)!;
      const rateRow = inboxRateRows.get(email.toLowerCase());
      const bounceDriven = bounceRotations.has(email.toLowerCase());
      // Bounce-only pulls may lack a same-ESP placement row; don't require one.
      const rate =
        inboxRates.get(email.toLowerCase()) ??
        (bounceDriven ? bounceRotations.get(email.toLowerCase())! : undefined);
      if (typeof rate !== "number") continue;
      const key = `remediate-inbox:${email.toLowerCase()}`;
      if (this.state.hasRemediation(key)) continue;
      if (this.state.getHeldInbox(email)) continue;
      if (this.state.getRestingInbox(email)) continue;

      // Bounce still rotates. Low inbox alone defers when copy looks guilty.
      if (!bounceDriven) {
        const onCampaigns = campaignIdsOf(account).filter((id) => {
          const status = campaignStatus.get(id);
          return !status || status === "ACTIVE";
        });
        if (
          onCampaigns.length &&
          onCampaigns.every((id) => copyDeferByCampaign.has(id))
        ) {
          continue;
        }
      }

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
                this.state.markPendingResume({
                  campaignId,
                  pausedAt: new Date().toISOString(),
                  reason: "remediation_last_account",
                });
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
              this.state.markPendingResume({
                campaignId,
                pausedAt: new Date().toISOString(),
                reason: "remediation_last_account",
              });
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

      const holdOutcome = classifyHoldOutcome({
        removeFailures,
        warmupOk,
        removedCount: removedFrom.length,
        dryRun: result.dryRun,
      });
      if (holdOutcome === "retry-removal-failed") {
        result.errors.push(
          `${email}: ${removeFailures} campaign removal(s) failed — left unheld so the next run retries`,
        );
        continue;
      }
      if (holdOutcome === "retry-nothing-achieved") continue;

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
              inboxRateSameEsp: rateRow?.inboxRateSameEsp,
              scoredSameEsp: bounceDriven
                ? rateRow?.scoredSameEsp
                : rateRow?.scoredSameEsp === true,
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
        // `rate` is the bounce rate when there is no placement row, so the
        // reader needs to know which number they are looking at — 25% bounce
        // and 25% inbox mean opposite things.
        bounceDriven,
        removedFromCampaigns: removedFrom,
        holdUntil: holdUntilDate,
        tagName,
        warmupEnabled: warmupOk,
        ...accountClient(account),
      });

      const pending = pendingHold.find((p) => p.accountId === account.id);
      if (pending) pending.removedFromCampaigns = removedFrom;

      // A failed removal already bailed above, so reaching here means the
      // mailbox really is off its campaigns — safe to dedupe.
      if (warmupOk) {
        this.state.markRemediation(key);
      }
    }

    // Holds that have served their D6 term go back into supply. Runs before
    // the still-active reconcile so a sender is not re-pulled on its way out.
    result.heldRelease = await this.releaseServedHolds({
      accounts,
      bounceRotations,
      dryRun: result.dryRun,
    });
    result.errors.push(...result.heldRelease.errors);

    // Anything already held but still on an ACTIVE campaign is still sending —
    // re-pull it. Runs after the main loop, which skips held mailboxes.
    result.heldReconcile = await this.reconcileHeldStillOnCampaigns({
      accounts,
      campaignStatus,
      dryRun: result.dryRun,
    });
    result.errors.push(...result.heldReconcile.errors);

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
              inboxRateSameEsp: row.inboxRateSameEsp,
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
   * Let go of holds that have served their term.
   *
   * D6 holds a benched sender `RECOVERY_HOLD_DAYS` (14) "before returning",
   * but nothing ever returned them: `heldInboxes` records are only cleared by
   * a pool-swap restore, the same-ESP audit, BCP restore, or a manual
   * rotation. With none of those firing a record lives forever, and because
   * `getHeldInbox` gates remediation, campaign top-up and fan-out, the mailbox
   * is out of supply permanently.
   *
   * Term is measured from `heldAt` against the current setting, deliberately
   * not against the stamped `holdUntil` — holds written before D6 landed carry
   * a 28-day stamp from the old `+4 weeks` default, and those senders have
   * long since served the 14 days Josh actually asked for.
   */
  async releaseServedHolds(opts: {
    accounts: SmartleadAccountWithCampaigns[];
    bounceRotations: Map<string, number>;
    dryRun: boolean;
  }): Promise<HeldReleaseResult> {
    const out: HeldReleaseResult = {
      dryRun: opts.dryRun,
      heldChecked: 0,
      released: [],
      keptOnBounce: 0,
      skippedActiveSwap: 0,
      errors: [],
    };

    const term = this.config.recoveryHoldDays;
    const byEmail = new Map(
      opts.accounts
        .map((a) => [accountEmail(a)?.toLowerCase(), a] as const)
        .filter((x): x is [string, SmartleadAccountWithCampaigns] => Boolean(x[0])),
    );

    for (const record of this.state.listHeldInboxes()) {
      const email = record.email.toLowerCase();
      out.heldChecked += 1;

      // A pool generic is covering this sender's campaigns; RecoveryPoolService
      // restores the pair together and must not be pre-empted here.
      if (this.state.getSwap(email)) {
        out.skippedActiveSwap += 1;
        continue;
      }

      const heldDays = record.heldAt
        ? (Date.now() - Date.parse(record.heldAt)) / 86_400_000
        : Number.NaN;
      if (!Number.isFinite(heldDays) || heldDays < term) continue;

      // Bounce is independent of the hold clock (D5). Returning a sender that
      // still fails it would put a known bouncer straight back into supply.
      if (opts.bounceRotations.has(email)) {
        out.keptOnBounce += 1;
        continue;
      }

      try {
        if (!opts.dryRun) {
          const account = byEmail.get(email);
          const tagIds = new Set<number>();
          for (const t of account?.tags ?? []) {
            const id = (t as { tag_id?: number; id?: number }).tag_id ??
              (t as { id?: number }).id;
            const name =
              (t as { tag_name?: string; name?: string }).tag_name ??
              (t as { name?: string }).name ??
              "";
            if (typeof id === "number" && /^HOLD-UNTIL-/i.test(name)) {
              tagIds.add(id);
            }
          }
          if (account?.id && tagIds.size) {
            await this.smartlead.removeTags([account.id], [...tagIds]);
            await sleep(200);
          }
          // Both gates must clear or the sender stays skipped: the main loop
          // checks getHeldInbox *and* hasRemediation.
          this.state.clearHeldInbox(email);
          this.state.clearInboxRemediation(email);
        }
        out.released.push({
          email,
          heldDays: Number(heldDays.toFixed(1)),
          stampedUntil: record.holdUntil,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.errors.push(`release hold ${email}: ${message}`);
      }
    }

    console.log("[remediation] hold release", {
      term,
      heldChecked: out.heldChecked,
      released: out.released.length,
      keptOnBounce: out.keptOnBounce,
      skippedActiveSwap: out.skippedActiveSwap,
      errors: out.errors.length,
    });
    return out;
  }

  /**
   * Re-pull mailboxes that are marked held but are still attached to ACTIVE
   * campaigns — i.e. believed benched while still sending.
   *
   * The hold decision itself was right; only the removal failed. Two paths
   * produced these: a removal failure that still got recorded as held (fixed
   * in classifyHoldOutcome), and fan-out re-attaching benched senders (fixed
   * by its held check). Both are closed, but the mailboxes already stranded
   * stay stranded — the main loop skips anything already held, so nothing
   * retries them. This reconciles that state rather than un-holding them.
   */
  async reconcileHeldStillOnCampaigns(opts: {
    accounts: SmartleadAccountWithCampaigns[];
    campaignStatus: Map<number, string>;
    dryRun: boolean;
  }): Promise<HeldReconcileResult> {
    const out: HeldReconcileResult = {
      dryRun: opts.dryRun,
      heldChecked: 0,
      stillActive: 0,
      repulled: [],
      deferredForFloor: 0,
      errors: [],
    };

    // Current staffing per ACTIVE campaign, so one pass cannot gut a campaign.
    const floor = this.config.minCampaignSenders;
    const remainingByCampaign = new Map<number, number>();
    for (const a of opts.accounts) {
      for (const id of campaignIdsOf(a)) {
        if (opts.campaignStatus.get(id) !== "ACTIVE") continue;
        remainingByCampaign.set(id, (remainingByCampaign.get(id) ?? 0) + 1);
      }
    }

    for (const account of opts.accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email || !account.id) continue;

      // Held in our state, or carrying an unexpired HOLD-UNTIL tag in
      // Smartlead without a state record — both mean "should not be sending".
      const held =
        Boolean(this.state.getHeldInbox(email)) ||
        Boolean(activeHoldUntilDate(tagNames(account)));
      if (!held) continue;
      out.heldChecked += 1;

      const activeIds = campaignIdsOf(account).filter(
        (id) => opts.campaignStatus.get(id) === "ACTIVE",
      );
      if (!activeIds.length) continue;
      out.stillActive += 1;

      const removed: number[] = [];
      for (const campaignId of activeIds) {
        // Never take a campaign that is currently at or above the D7 floor
        // below it in a single pass — the remainder is re-pulled on later runs
        // as top-up refills. A campaign already under the floor is not
        // protected here: keeping a benched sender on it does not help.
        const remaining = remainingByCampaign.get(campaignId) ?? 0;
        if (remaining >= floor && remaining - 1 < floor) {
          out.deferredForFloor += 1;
          continue;
        }
        try {
          if (!opts.dryRun) {
            const onCampaign =
              await this.smartlead.getCampaignEmailAccounts(campaignId);
            if (!onCampaign.some((a) => a.id === account.id)) {
              removed.push(campaignId);
              continue;
            }
            // Smartlead rejects removing the last account from an ACTIVE
            // campaign — pause first, same as the main recovery path.
            if (onCampaign.filter((a) => a.id !== account.id).length === 0) {
              await this.smartlead.updateCampaignStatus(campaignId, "PAUSED");
              this.state.markPendingResume({
                campaignId,
                pausedAt: new Date().toISOString(),
                reason: "held_reconcile_last_account",
              });
            }
            await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
              account.id,
            ]);
            await sleep(300);
          }
          removed.push(campaignId);
          remainingByCampaign.set(campaignId, remaining - 1);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          out.errors.push(
            `held re-pull ${email} from campaign ${campaignId}: ${message}`,
          );
        }
      }

      if (removed.length) out.repulled.push({ email, campaignIds: removed });
    }

    console.log("[remediation] held reconcile", {
      heldChecked: out.heldChecked,
      stillActive: out.stillActive,
      repulled: out.repulled.length,
      deferredForFloor: out.deferredForFloor,
      errors: out.errors.length,
    });
    return out;
  }

  /**
   * Re-score held inboxes with same-ESP rules and restore any that were
   * pulled only because cross-ESP (blended) scores looked bad.
   */
  async auditAndRestoreFalseHolds(opts: {
    accounts: SmartleadAccountWithCampaigns[];
    inboxRateRows: Map<string, SenderInboxRate>;
    bounceRotations: Map<string, number>;
    dryRun: boolean;
  }): Promise<SameEspAuditResult> {
    const out: SameEspAuditResult = {
      dryRun: opts.dryRun,
      scoredSenders: opts.inboxRateRows.size,
      falseHoldsFound: 0,
      restored: [],
      stillHeldBelowThreshold: 0,
      skippedLowSamples: 0,
      noSameEspEvidence: 0,
      unprovenBlendedReleased: 0,
      heldOnBounce: 0,
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
      if (this.state.getRestingInbox(email)) continue;
      const row = opts.inboxRateRows.get(email);
      const sameSamples = row?.sameEspSamples ?? 0;
      const sameRate = row?.inboxRateSameEsp;
      const allRate = row?.inboxRateAll ?? row?.inboxRate;
      const hasSameEspEvidence =
        typeof sameRate === "number" && sameSamples >= minSame;

      if (hasSameEspEvidence) {
        // Same-ESP still condemns it — the hold stands (D32).
        if (sameRate < threshold) {
          out.stillHeldBelowThreshold += 1;
          continue;
        }
        // Same-ESP says healthy → restore (prior blended-score false positive).
      } else {
        // No usable same-ESP evidence. A held mailbox is off its campaigns, so
        // it drops out of placement tests and can never earn a fresh score —
        // waiting for one means the hold only ever expires on the clock.
        //
        // D32: a blended score is never grounds to pull, so it cannot be
        // grounds to *keep* holding either. Release those. Holds taken on a
        // same-ESP score (or with no placement score at all — bounce pulls)
        // are left alone; this is not a general amnesty.
        if (record.scoredSameEsp !== false) {
          out.noSameEspEvidence += 1;
          continue;
        }
        // A held record does not say why it was held, and a bounce-driven pull
        // can also carry scoredSameEsp=false. Bounce is an independent signal
        // (D5) — never hand a live campaign back a sender that still fails it.
        if (opts.bounceRotations.has(email)) {
          out.heldOnBounce += 1;
          continue;
        }
        out.unprovenBlendedReleased += 1;
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

      // A sender belongs to one CLIENT (D26/D27) — cross-client membership is
      // forbidden. Domain expansion above is unsafe for generic-pool domains:
      // `crossscaleco.com` sits on every client's campaigns, so reattaching by
      // domain alone would put one mailbox on 23 campaigns across 5 clients.
      // Restrict to the client this mailbox was actually serving.
      const ownerClientId =
        client.clientId ??
        [...targetCampaigns]
          .map((id) => campaignClientById.get(id))
          .find((c) => c !== null && c !== undefined);
      for (const id of [...targetCampaigns]) {
        const campClient = campaignClientById.get(id);
        if (campClient !== ownerClientId) targetCampaigns.delete(id);
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
          reason:
            typeof sameRate === "number"
              ? `same-ESP ${sameRate.toFixed(1)}% (≥${threshold}%) over ${sameSamples} seeds; blended was ${
                  typeof allRate === "number" ? `${allRate.toFixed(1)}%` : "n/a"
                }`
              : `held on a blended score with no same-ESP evidence since (D32); bounce clean${
                  typeof allRate === "number"
                    ? `; blended reads ${allRate.toFixed(1)}%`
                    : ""
                }`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.errors.push(`audit restore ${email}: ${message}`);
      }
    }

    // Every bucket is logged: a bare "falseHoldsFound: 0" used to read as
    // "nothing wrong" when it really meant "nothing could be evaluated".
    console.log("[remediation] same-ESP audit", {
      heldTotal: held.length,
      scoredSenders: out.scoredSenders,
      falseHoldsFound: out.falseHoldsFound,
      restored: out.restored.length,
      stillHeldBelowThreshold: out.stillHeldBelowThreshold,
      skippedLowSamples: out.skippedLowSamples,
      noSameEspEvidence: out.noSameEspEvidence,
      unprovenBlendedReleased: out.unprovenBlendedReleased,
      heldOnBounce: out.heldOnBounce,
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
      if (this.state.getRestingInbox(email)) continue;
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
      heldReleased: result.heldRelease?.released.length ?? 0,
      heldStillActive: result.heldReconcile?.stillActive ?? 0,
      heldRepulled: result.heldReconcile?.repulled.length ?? 0,
      errors: result.errors.length,
    });

    // The count alone is unreadable — a run reporting "errors: 40" gave no way
    // to tell 40 purged test ids from 40 failed campaign removals. Print the
    // actual messages, collapsed by shape so one repeated fault is one line.
    if (result.errors.length) {
      const shapes = summarizeErrors(result.errors);
      console.warn(
        `[remediation] ${result.errors.length} error(s) in ${shapes.length} distinct shape(s):`,
      );
      for (const s of shapes) console.warn(`  x${s.count}  ${s.sample}`);
    }

    const acted =
      result.deletedSmartleadAccounts.length > 0 ||
      result.purgedInboxKitDomains.length > 0 ||
      result.recoveredInboxes.length > 0 ||
      result.holdTagged > 0 ||
      result.clientActions.length > 0 ||
      (result.sameEspAudit?.restored.length ?? 0) > 0 ||
      (result.recoveryPool?.swaps.length ?? 0) > 0 ||
      (result.recoveryPool?.restores.length ?? 0) > 0;

    // Rate-limit / approval-gate / burn-checklist noise alone should not page Slack
    const seriousErrors = result.errors.filter((e) => !isBenignOpsNoise(e));

    if (acted || seriousErrors.length) {
      await this.slack.notifyRemediation({
        ...result,
        errors: seriousErrors,
      }).catch((error) => {
        console.error("[remediation] Slack notify failed", error);
      });
    } else if (result.errors.length) {
      console.log(
        `[remediation] Skipping Slack (no actions; ${result.errors.length} benign ops noise error(s))`,
      );
    }
  }

  private refreshRestingScores(inboxRateRows: Map<string, SenderInboxRate>): void {
    for (const rest of this.state.listRestingInboxes()) {
      const row = inboxRateRows.get(rest.email.toLowerCase());
      if (row?.scoredSameEsp !== true || typeof row.inboxRate !== "number") {
        continue;
      }
      this.state.markRestingInbox({
        ...rest,
        lastSameEspInbox: row.inboxRate,
      });
    }
  }

  private async notifyBounceWatch(
    watches: Array<{ email: string; bounceRate: number; sent: number }>,
  ): Promise<void> {
    const fresh = watches.filter((w) => {
      const key = `bounce-watch:${w.email.toLowerCase()}`;
      return !this.state.hasRecentAlert(key, 24 * 60 * 60 * 1000);
    });
    if (!fresh.length) return;
    const lines = [
      `Bounce watch (≥${this.config.bounceRateWarnThreshold}%, below the ${this.config.bounceRateThreshold}% pull):`,
      ...fresh
        .slice(0, 15)
        .map(
          (w) =>
            `- ${w.email} — ${w.bounceRate.toFixed(1)}% bounce on ${w.sent} sends`,
        ),
    ];
    if (fresh.length > 15) {
      lines.push(`- …and ${fresh.length - 15} more`);
    }
    try {
      await this.slack.send(lines.join("\n"));
      for (const w of fresh) {
        this.state.markAlert(`bounce-watch:${w.email.toLowerCase()}`);
      }
    } catch (error) {
      console.warn("[remediation] bounce-watch Slack failed", error);
    }
  }

}

/**
 * True when a human denied blacklisted-domain teardown for this domain.
 * Monthly-cap denials are excluded — those can cycle next month via SpendGateway.
 */
export function isHumanDeniedTeardown(
  state: Pick<StateStore, "getLatestSpendApprovalForRequest">,
  domain: string,
): boolean {
  const record = state.getLatestSpendApprovalForRequest(
    `teardown-domain:${domain.toLowerCase()}`,
  );
  return (
    record?.status === "denied" && record.decidedBy !== "monthly-cap"
  );
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
