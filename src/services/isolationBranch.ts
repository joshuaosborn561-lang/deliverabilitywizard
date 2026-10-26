import type { CanonConvergeService } from "./canonConverge.js";
import { onWeekCohort } from "../lib/restCohort.js";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  type SmartleadClient,
} from "../clients/smartlead.js";
import {
  campaignIdOf,
  normalizeTestList,
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  testIdOf,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { filterCountableBlacklistHits } from "../lib/blacklistIgnore.js";
import { recordInfraIsolationUnlink } from "../lib/attachBlock.js";
import { decideIsolationVerdict } from "../lib/isolationVerdict.js";
import {
  allEspsAtOrAbove,
  anyEspBelowThreshold,
  type ProviderInboxSplit,
} from "../lib/copySignal.js";
import { campaignProof } from "../lib/isolationProof.js";
import { nyDateLabel } from "../lib/campaignDayStats.js";
import type { IsolationRunRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import {
  isCanaryCopyTestName,
  isIsolationManagedTestName,
} from "../lib/isolationNames.js";
import {
  isActiveSendingStatus,
  isolationSuspectsDueForEval,
  isTerminalIsolationVerdict,
  liveCampaignForPlacementTrigger,
  minSameEspInbox,
  placementSuspectReason,
  sameEspInboxUgly,
  shouldRequeueIsolation,
} from "../lib/placementSuspect.js";
import { isAbortError, throwIfAborted } from "../lib/abortWork.js";
import { yieldEventLoop } from "../lib/stringifyYielding.js";
import { isExcluded } from "./campaignTopUp.js";
import type { CopyIsolationService } from "./copyIsolation.js";
import type { IsolationRigService } from "./isolationRig.js";
import type { CopyCanaryService } from "./copyCanary.js";

/** D165 leftover skip: dead campaigns only. PAUSED still re-reads (D164). */
function isFinishedSendingStatus(
  status: string | undefined | null,
): boolean {
  const normalized = String(status ?? "").toUpperCase();
  return normalized === "COMPLETED" || normalized === "STOPPED";
}

/** Skip a provider-split fetch when the score is still this fresh. */
export const PLACEMENT_SCORE_FRESH_MS = 3 * 60 * 60 * 1000;
/**
 * D267 — keep the 10-minute stage race. Prod 2026-10-14: cap 12 / 8
 * plus `await save()` after prune blew the budget every cycle.
 */
export const ISOLATION_PROVIDER_SPLITS_CAP = 4;
export const ISOLATION_EVALUATE_CAP = 3;
/** Leave ~3 minutes of slack before the D247 10-minute race. */
export const ISOLATION_STEP_BUDGET_MS = 7 * 60 * 1000;

export interface IsolationBranchResult {
  dryRun: boolean;
  evaluated: number;
  copy: number;
  infra: number;
  inconclusive: number;
  teardowns: number;
  errors: string[];
  /** D267 — leftover evaluates / pulls waiting for the next sitting. */
  deferred?: number;
  partial?: boolean;
}

export class IsolationBranchService {
  private listedTestsThisRun: ReturnType<typeof normalizeTestList> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly copyIsolation: CopyIsolationService,
    private readonly rig: IsolationRigService,
    private readonly copyCanary?: CopyCanaryService,
  ) {}

  /** D303 — rest-then-burn hook. Wired in index.ts. */
  private restRule: Pick<CanonConvergeService, "onIsolationVerdict"> | null = null;

  setRestRule(rule: Pick<CanonConvergeService, "onIsolationVerdict"> | null): void {
    this.restRule = rule;
  }

  async run(opts: {
    dryRun?: boolean;
    campaignId?: number;
    signal?: AbortSignal;
    budgetMs?: number;
    now?: () => number;
  } = {}): Promise<IsolationBranchResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: IsolationBranchResult = {
      dryRun,
      evaluated: 0,
      copy: 0,
      infra: 0,
      inconclusive: 0,
      teardowns: 0,
      errors: [],
    };
    if (!this.config.enableIsolationBranch) return result;

    const clock = opts.now ?? Date.now;
    const budgetMs = opts.budgetMs ?? ISOLATION_STEP_BUDGET_MS;
    const deadline = clock() + budgetMs;
    const overBudget = (): boolean => clock() >= deadline;
    const persistHot = async (): Promise<void> => {
      try {
        await this.state.persistIsolationPrune();
      } catch (error) {
        console.warn("[isolation-branch] sidecar prune persist failed", error);
      }
    };

    this.listedTestsThisRun = null;
    let campaigns: Awaited<ReturnType<SmartleadClient["listCampaigns"]>> = [];
    let listedOk = false;
    if (!opts.campaignId) {
      try {
        throwIfAborted(opts.signal);
        campaigns = await this.smartlead.listCampaigns();
        listedOk = true;
        const pruned = this.state.pruneIsolationForGoneCampaigns(campaigns);
        if (pruned) {
          console.log(
            `[isolation-branch] pruned ${pruned} score/suspect/canary row(s) for deleted or finished campaigns (D261/D262/D267)`,
          );
          // D267 — sidecar first (fast). Do not await the full dump;
          // stringify ate the 10m budget and freeze-kills discarded it.
          await persistHot();
          void this.state.save().catch((error) => {
            console.warn("[isolation-branch] full save after prune failed", error);
          });
        }
      } catch (error) {
        if (isAbortError(error)) {
          result.errors.push("aborted: stopped before placement queue");
          result.partial = true;
          await persistHot();
          return result;
        }
        console.warn(
          "[isolation-branch] could not list campaigns for placement queue",
          error,
        );
      }
      if (overBudget() || opts.signal?.aborted) {
        result.partial = true;
        result.errors.push("budget: stopped before placement queue (D267)");
        await persistHot();
        return result;
      }
      try {
        await this.queueUglyFromExistingScores(campaigns, opts.signal);
        await this.queueUglyPlacementSuspects(campaigns, opts.signal, {
          overBudget,
        });
      } catch (error) {
        if (isAbortError(error)) {
          result.errors.push("aborted: stopped during placement queue");
          result.partial = true;
        } else {
          throw error;
        }
      }
    }

    const statusById = new Map(
      campaigns.map((row) => [row.id, row.status] as const),
    );
    // D164: re-read INCONCLUSIVE (incl. PAUSED + evaluatedAt).
    // D165: leftover evaluate skips COMPLETED/STOPPED (dead, not sending).
    // D261: deleted / missing from the live list are pruned, not evaluated.
    // PAUSED stays in the re-read set; Slack/re-queue stay ACTIVE-only.
    const due = opts.campaignId
      ? []
      : isolationSuspectsDueForEval(
          this.state.listCopySuspects(),
          (campaignId) => this.state.latestIsolationRunForCampaign(campaignId),
        );
    const skippedFinished = listedOk
      ? due.filter((row) =>
          isFinishedSendingStatus(statusById.get(row.campaignId)),
        )
      : [];
    const skippedMissing = listedOk
      ? due.filter((row) => !statusById.has(row.campaignId))
      : [];
    if (skippedFinished.length) {
      console.log(
        `[isolation-branch] skip ${skippedFinished.length} COMPLETED/STOPPED leftover suspect(s) (D165)`,
      );
    }
    if (skippedMissing.length) {
      console.log(
        `[isolation-branch] skip ${skippedMissing.length} deleted leftover suspect(s) (D261)`,
      );
    }
    const targets = opts.campaignId
      ? [{ campaignId: opts.campaignId }]
      : due.filter(
          (row) =>
            !listedOk ||
            (statusById.has(row.campaignId) &&
              !isFinishedSendingStatus(statusById.get(row.campaignId))),
        );
    const evaluateTargets = opts.campaignId
      ? targets
      : targets.slice(0, ISOLATION_EVALUATE_CAP);
    if (!opts.campaignId && targets.length > evaluateTargets.length) {
      result.deferred = (result.deferred ?? 0) + (targets.length - evaluateTargets.length);
      console.log(
        `[isolation-branch] evaluate cap ${ISOLATION_EVALUATE_CAP}; ${targets.length - evaluateTargets.length} leftover(s) wait for the next cycle (D262/D267)`,
      );
    }

    for (const target of evaluateTargets) {
      if (opts.signal?.aborted || overBudget()) {
        result.partial = true;
        result.errors.push(
          opts.signal?.aborted
            ? "aborted: stopped remaining isolation evaluates"
            : "budget: stopped remaining isolation evaluates (D267)",
        );
        result.deferred = (result.deferred ?? 0) + 1;
        break;
      }
      try {
        await yieldEventLoop();
        throwIfAborted(opts.signal);
        const priorReason = this.state
          .listCopySuspects()
          .find((row) => row.campaignId === target.campaignId)?.reason;
        const run = await this.evaluate(target.campaignId, {
          dryRun,
          campaignInSpam: true,
          contentBlock: /content_block/i.test(priorReason ?? ""),
          persist: false,
          signal: opts.signal,
        });
        result.evaluated += 1;
        if (run.verdict === "COPY") result.copy += 1;
        else if (run.verdict === "INFRA") result.infra += 1;
        else result.inconclusive += 1;
        if (run.teardownStarted) result.teardowns += 1;
        const prior = this.state
          .listCopySuspects()
          .find((row) => row.campaignId === target.campaignId);
        this.state.markCopySuspect({
          campaignId: target.campaignId,
          campaignName: run.campaignName,
          at: prior?.at ?? new Date().toISOString(),
          reason: prior?.reason,
          // INCONCLUSIVE stays queued so a later canary/known-good reading can finish the branch.
          evaluatedAt: isTerminalIsolationVerdict(run.verdict)
            ? new Date().toISOString()
            : prior?.evaluatedAt,
        });
      } catch (error) {
        if (isAbortError(error)) {
          result.partial = true;
          result.errors.push("aborted: stopped remaining isolation evaluates");
          break;
        }
        result.errors.push(
          `#${target.campaignId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await persistHot();
    void this.state.save().catch((error) => {
      console.warn("[isolation-branch] end-of-run full save failed", error);
    });
    if (result.partial) {
      console.log(
        `[isolation-branch] partial pass stamped; deferred=${result.deferred ?? 0} (D267)`,
      );
    }
    return result;
  }

  /**
   * D158 — dominant bounce content_block is the same copy-suspect flag
   * as an ugly canary. Idempotent with shouldRequeueIsolation.
   */
  async queueContentBlockSuspect(campaignId: number): Promise<void> {
    if (!this.config.enableIsolationBranch) return;
    let campaign: Awaited<ReturnType<SmartleadClient["getCampaign"]>>;
    try {
      campaign = await this.smartlead.getCampaign(campaignId);
    } catch (error) {
      console.warn(
        `[isolation-branch] content_block queue could not load #${campaignId}`,
        error,
      );
      return;
    }
    if (
      isExcluded(campaign, this.config.topUpExcludeCampaigns) ||
      isAnyShellCampaign(campaign) ||
      !isActiveSendingStatus(campaign.status)
    ) {
      return;
    }
    const existing = this.state
      .listCopySuspects()
      .find((row) => row.campaignId === campaignId);
    const openRun = this.state.latestIsolationRunForCampaign(campaignId);
    if (!shouldRequeueIsolation({ existing, openRun, status: campaign.status })) {
      return;
    }
    this.state.markCopySuspect({
      campaignId,
      campaignName: campaign.name,
      at: existing?.at ?? new Date().toISOString(),
      reason: existing?.reason?.includes("content_block")
        ? existing.reason
        : "dominant bounce class content_block",
      evaluatedAt: undefined,
    });
    const run = await this.evaluate(campaignId, {
      campaignInSpam: true,
      contentBlock: true,
    });
    const prior = this.state
      .listCopySuspects()
      .find((row) => row.campaignId === campaignId);
    this.state.markCopySuspect({
      campaignId,
      campaignName: run.campaignName,
      at: prior?.at ?? new Date().toISOString(),
      reason: prior?.reason ?? "dominant bounce class content_block",
      evaluatedAt: isTerminalIsolationVerdict(run.verdict)
        ? new Date().toISOString()
        : prior?.evaluatedAt,
    });
    await this.state.save();
  }

  async evaluate(
    campaignId: number,
    opts: {
      dryRun?: boolean;
      campaignInSpam?: boolean;
      silent?: boolean;
      contentBlock?: boolean;
      persist?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<IsolationRunRecord> {
    throwIfAborted(opts.signal);
    // D287 — isolation never hold-pauses a campaign. Evaluate only
    // scores and starts a run. Never write campaign status.
    const campaign = await this.smartlead.getCampaign(campaignId);
    if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) {
      const skipped: IsolationRunRecord = {
        id: randomUUID(),
        campaignId,
        campaignName: campaign.name,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        control: "INSUFFICIENT",
        verdict: "INCONCLUSIVE",
        campaignInSpam: false,
        reason: "Campaign is on the leave-alone list.",
      };
      this.state.upsertIsolationRun(skipped);
      return skipped;
    }

    const accounts = await this.smartlead.getCampaignEmailAccounts(campaignId);
    const emails = accounts
      .map((account) => accountEmail(account)?.toLowerCase())
      .filter((email): email is string => Boolean(email));
    const senderControls = emails.map(
      (email) => this.state.getMailboxControl(email)?.placement ?? "UNKNOWN",
    );
    const campaignInSpam =
      opts.campaignInSpam ?? (await this.campaignLooksSpam(campaignId));
    const knownGoodFineAcrossEsps = await this.knownGoodFineAcrossEsps(emails);
    const unwarmedCopyFineAcrossEsps =
      await this.unwarmedCopyFineAcrossEsps(campaignId);
    const rigPrimary = await this.rig.readLatestControl();
    const rigEmails = await this.rig.rigEmails();
    const copyCanarySplit = this.copyCanary
      ? await this.copyCanary.readSplit(campaignId)
      : null;
    const decided = decideIsolationVerdict({
      campaignInSpam,
      senderControls,
      knownGoodFineAcrossEsps,
      unwarmedCopyFineAcrossEsps,
      copyCanary: copyCanarySplit,
      contentBlock: opts.contentBlock === true,
      rig: {
        controlPrimary: decidedNeedsRig(campaignInSpam, senderControls)
          ? rigPrimary
          : null,
        copyPrimary: null,
        mailboxCount: rigEmails.length,
      },
    });

    let infraCheck: Record<string, unknown> | undefined;
    if (decided.pullInfraDiagnostics) {
      infraCheck = await this.infraFromLatestControl(emails);
    }

    const run: IsolationRunRecord = {
      id: randomUUID(),
      campaignId,
      campaignName: campaign.name,
      client: campaign.name,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      control: decided.control,
      verdict: decided.verdict,
      campaignInSpam,
      reason: decided.reason,
      infraCheck,
      teardownStarted: false,
    };
    this.state.upsertIsolationRun(run);

    // D176 — INFRA means the inboxes/domain are the problem. Stamp
    // attach blocks on known-good-condemned sender domains so restaff
    // cannot put them back after a human / QA unlink. Does not pull (D51).
    if (decided.verdict === "INFRA" && !opts.dryRun) {
      const blocked = recordInfraIsolationUnlink(this.state, accounts, {
        campaignId,
        extraGenericDomains: this.config.extraGenericDomains,
        placementOf: (email) =>
          this.state.getMailboxControl(email)?.placement ?? "UNKNOWN",
      });
      if (blocked.length) {
        console.log(
          `[isolation-branch] D176 attach-block INFRA #${campaignId}: ${blocked
            .map((row) => row.domain)
            .join(", ")}`,
        );
      }
    }

    // D303 — mailbox (not copy) is the cause: rest it 14 days, generic
    // covers its seat; burn on repeat. Replaces kill-only (D51/D128) here.
    if (decided.verdict === "INFRA" && !opts.dryRun && this.restRule) {
      try {
        const clientId = typeof campaign.client_id === "number" ? campaign.client_id : null;
        if (clientId !== null) {
          await this.restRule.onIsolationVerdict({
            verdict: decided.verdict,
            clientId,
            pod: onWeekCohort(),
            campaignId,
            accounts,
            sameEspOf: (email) => this.state.getMailboxControl(email),
          });
        }
      } catch (error) {
        console.warn(`[isolation-branch] D303 rest rule #${campaignId} failed`, error);
      }
    }

    if (
      decided.verdict === "COPY" &&
      this.config.enableCopyIsolation &&
      !opts.dryRun
    ) {
      const teardown = await this.copyIsolation.runForCampaign(run);
      run.teardownStarted = teardown.started || teardown.waiting;
      if (!teardown.started) {
        await this.rig.ensureArmed();
      }
      run.updatedAt = new Date().toISOString();
      this.state.upsertIsolationRun(run);
    }

    const canaryLine = this.copyCanary?.describeSplit(copyCanarySplit);
    const proof = campaignProof({
      verdict: decided.verdict,
      controlVersion: this.state.getIsolation().controlTemplate?.controlVersion,
      senderSummary: `${emails.length} inbox${emails.length === 1 ? "" : "es"} on this campaign`,
      whyNotTheOther: [
        whyNotTheOtherCause(decided.verdict, decided.reason),
        canaryLine,
      ]
        .filter(Boolean)
        .join(" "),
      next:
        decided.verdict === "COPY"
          ? "I will not edit the live email until Josh or Cayden tap Make the changes."
          : decided.verdict === "INFRA"
            ? "I will not rewrite the email. Domain retire or a replacement buy waits for Cayden (or Josh)."
            : "I will keep testing. A campaign in spam is a flag, not a domain death sentence.",
    });
    run.notes = proof;
    this.state.upsertIsolationRun(run);

    // D163 — COPY / INFRA / INCONCLUSIVE page Slack (D69 COPY mute is
    // superseded). D165 — INCONCLUSIVE only pages ACTIVE senders.
    // Word hunt still pages the phrase + substitute later.
    // Deduped per campaign per verdict so the 15-minute sweep stays quiet.
    const pageInconclusive =
      decided.verdict === "INCONCLUSIVE" &&
      isActiveSendingStatus(campaign.status);
    if (
      !opts.silent &&
      (decided.verdict === "COPY" ||
        decided.verdict === "INFRA" ||
        pageInconclusive) &&
      this.state.getCanonMissAlert(campaignId) !== decided.verdict
    ) {
      await this.slack.notifyIsolationVerdict({
        campaignName: campaign.name,
        clientName: campaign.name,
        dateLabel: nyDateLabel(),
        verdict: decided.verdict,
        reason: decided.reason,
        teardownStarted: run.teardownStarted,
        infraSummary: summarizeInfra(infraCheck),
        proof,
      });
      this.state.setCanonMissAlert(campaignId, decided.verdict);
    }
    if (opts.persist !== false) await this.state.save();
    return run;
  }

  /**
   * D158 — canary-copy or live placement same-ESP under the live 80% bar
   * queues the ACTIVE campaign as a copy suspect. Isolation then decides
   * COPY vs INFRA. D163 pages Slack once per campaign per incident
   * (ugly / queued / verdict) from the health-pass CANON-miss pager.
   */
  async queueUglyPlacementSuspects(
    campaigns: Awaited<ReturnType<SmartleadClient["listCampaigns"]>>,
    signal?: AbortSignal,
    opts: { overBudget?: () => boolean } = {},
  ): Promise<number> {
    throwIfAborted(signal);
    const listedTests = normalizeTestList(
      await this.smartDelivery.listTests({}).catch(() => []),
    );
    this.listedTestsThisRun = listedTests;
    const tests = [
      ...listedTests,
      ...this.syntheticCopyCanaryTests(listedTests),
    ].sort((a, b) => {
      const ac = isCanaryCopyTestName(a.test_name) ? 0 : 1;
      const bc = isCanaryCopyTestName(b.test_name) ? 0 : 1;
      return ac - bc;
    });
    let queued = 0;
    let pulled = 0;
    const seen = new Set<number>();
    const now = Date.now();

    for (const test of tests) {
      if (signal?.aborted || opts.overBudget?.()) break;
      await yieldEventLoop();
      const target = liveCampaignForPlacementTrigger({
        testName: test.test_name,
        testCampaignId: campaignIdOf(test),
        campaigns,
      });
      if (!target) continue;
      if (seen.has(target.campaignId)) continue;
      const campaign = campaigns.find((row) => row.id === target.campaignId);
      if (
        !campaign ||
        isExcluded(campaign, this.config.topUpExcludeCampaigns) ||
        isAnyShellCampaign(campaign)
      ) {
        continue;
      }

      const tid = testIdOf(test);
      if (!tid) continue;
      if (
        isIsolationManagedTestName(test.test_name) &&
        !isCanaryCopyTestName(test.test_name)
      ) {
        continue;
      }
      seen.add(target.campaignId);
      const existingScore = this.state
        .listPlacementScores()
        .find((row) => row.campaignId === target.campaignId);
      const scoreAgeMs = existingScore
        ? now - Date.parse(existingScore.at)
        : Number.POSITIVE_INFINITY;
      // D262 — a fresh score is already on the hole / suspect list.
      // Re-read happens in evaluate. Do not N+1 providerSplits again.
      if (
        existingScore &&
        Number.isFinite(scoreAgeMs) &&
        scoreAgeMs < PLACEMENT_SCORE_FRESH_MS
      ) {
        if (
          existingScore.inboxPercent < this.config.remediationInboxThreshold &&
          shouldRequeueIsolation({
            existing: this.state
              .listCopySuspects()
              .find((row) => row.campaignId === target.campaignId),
            openRun: this.state.latestIsolationRunForCampaign(target.campaignId),
            status: campaign.status,
          })
        ) {
          this.state.markCopySuspect({
            campaignId: target.campaignId,
            campaignName: target.campaignName ?? campaign.name,
            at: new Date().toISOString(),
            reason: placementSuspectReason(
              existingScore.source,
              [
                {
                  name: existingScore.source,
                  inboxPercent: existingScore.inboxPercent,
                },
              ],
              this.config.remediationInboxThreshold,
            ),
            evaluatedAt: undefined,
          });
          queued += 1;
        }
        continue;
      }
      if (pulled >= ISOLATION_PROVIDER_SPLITS_CAP) {
        console.log(
          `[isolation-branch] provider-split cap ${ISOLATION_PROVIDER_SPLITS_CAP}; remaining tests wait (D262)`,
        );
        break;
      }
      pulled += 1;
      throwIfAborted(signal);
      const splits = await this.providerSplits(tid);
      const inbox = minSameEspInbox(splits);
      if (inbox != null) {
        this.state.recordPlacementScore({
          campaignId: target.campaignId,
          campaignName: target.campaignName ?? campaign.name,
          testId: tid,
          source: target.source,
          inboxPercent: inbox,
          at: new Date().toISOString(),
        });
      }
      if (!sameEspInboxUgly(splits, this.config.remediationInboxThreshold)) {
        continue;
      }
      if (
        !shouldRequeueIsolation({
          existing: this.state
            .listCopySuspects()
            .find((row) => row.campaignId === target.campaignId),
          openRun: this.state.latestIsolationRunForCampaign(target.campaignId),
          status: campaign.status,
        })
      ) {
        continue;
      }

      this.state.markCopySuspect({
        campaignId: target.campaignId,
        campaignName: target.campaignName ?? campaign.name,
        at: new Date().toISOString(),
        reason: placementSuspectReason(
          target.source,
          splits,
          this.config.remediationInboxThreshold,
        ),
        evaluatedAt: undefined,
      });
      queued += 1;
      if (
        !this.config.dryRun &&
        this.state.getCanonMissAlert(target.campaignId) !== "ugly"
      ) {
        await this.slack.notifyPlacementResult({
          testName: test.test_name,
          testId: tid,
          threshold: this.config.remediationInboxThreshold,
          providers: splits,
          remediationThreshold: this.config.remediationInboxThreshold,
        });
        this.state.setCanonMissAlert(target.campaignId, "ugly");
      }
      console.log(
        `[isolation-branch] queued #${target.campaignId} from ${target.source}: ${splits
          .map((row) => `${row.name} ${row.inboxPercent.toFixed(0)}%`)
          .join(", ")}`,
      );
    }
    return queued;
  }

  /**
   * D287 — 0% (and any under-80%) canary-copy scores already on the
   * book must become suspects even when listTests is empty or the
   * provider-split pull is skipped as fresh. Isolation starts from
   * the score; it never hold-pauses the campaign.
   */
  private async queueUglyFromExistingScores(
    campaigns: Awaited<ReturnType<SmartleadClient["listCampaigns"]>>,
    signal?: AbortSignal,
  ): Promise<number> {
    throwIfAborted(signal);
    const byId = new Map(campaigns.map((row) => [row.id, row]));
    let queued = 0;
    for (const score of this.state.listPlacementScores()) {
      await yieldEventLoop();
      if (score.inboxPercent >= this.config.remediationInboxThreshold) continue;
      const campaign = byId.get(score.campaignId);
      if (
        !campaign ||
        !isActiveSendingStatus(campaign.status) ||
        isExcluded(campaign, this.config.topUpExcludeCampaigns) ||
        isAnyShellCampaign(campaign)
      ) {
        continue;
      }
      if (
        !shouldRequeueIsolation({
          existing: this.state
            .listCopySuspects()
            .find((row) => row.campaignId === score.campaignId),
          openRun: this.state.latestIsolationRunForCampaign(score.campaignId),
          status: campaign.status,
        })
      ) {
        continue;
      }
      this.state.markCopySuspect({
        campaignId: score.campaignId,
        campaignName: score.campaignName ?? campaign.name,
        at: new Date().toISOString(),
        reason: placementSuspectReason(
          score.source,
          [{ name: score.source, inboxPercent: score.inboxPercent }],
          this.config.remediationInboxThreshold,
        ),
        evaluatedAt: undefined,
      });
      queued += 1;
      console.log(
        `[isolation-branch] queued #${score.campaignId} from stored ${score.source} ${score.inboxPercent.toFixed(0)}% (D287)`,
      );
    }
    return queued;
  }

  /** copyCanaries test ids that listTests omitted — still score them. */
  private syntheticCopyCanaryTests(
    listedTests: Array<{ id?: string | number; spam_test_id?: string | number }>,
  ): Array<{
    id: string;
    test_name: string;
    campaign_id?: number;
  }> {
    const already = new Set(
      listedTests
        .map((test) => testIdOf(test))
        .filter((id): id is string => Boolean(id)),
    );
    return this.state.listCopyCanaryTestIds().flatMap((id) => {
      if (already.has(id)) return [];
      already.add(id);
      const campaignId = this.state.campaignIdForCopyCanaryTestId(id);
      if (campaignId == null) return [];
      return [
        {
          id,
          test_name: `Canary copy: #${campaignId}`,
          campaign_id: campaignId,
        },
      ];
    });
  }

  private async campaignLooksSpam(campaignId: number): Promise<boolean> {
    const fresh = this.state
      .listPlacementScores()
      .find((row) => row.campaignId === campaignId);
    if (fresh) {
      const age = Date.now() - Date.parse(fresh.at);
      if (Number.isFinite(age) && age < PLACEMENT_SCORE_FRESH_MS) {
        return fresh.inboxPercent < this.config.remediationInboxThreshold;
      }
    }
    const tests =
      this.listedTestsThisRun ??
      (await this.smartDelivery.listTests({}).catch(() => []));
    const mine = tests.filter((test) => campaignIdOf(test) === String(campaignId));
    const latest = mine.sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    )[0];
    if (!latest) return true;
    const tid = latest.spam_test_id ?? latest.id;
    if (tid != null) {
      const splits = await this.providerSplits(String(tid));
      if (splits.length) {
        return anyEspBelowThreshold(
          splits,
          this.config.remediationInboxThreshold,
        );
      }
    }
    const spam = Number(latest.spam_count ?? 0);
    const inbox = Number(latest.inbox_count ?? 0);
    const total = spam + inbox + Number(latest.tab_count ?? 0);
    if (total <= 0) return true;
    return inbox / total * 100 < this.config.remediationInboxThreshold;
  }

  /** D96 — unwarmed fleet sending this campaign copy, every scored ESP. */
  private async unwarmedCopyFineAcrossEsps(
    campaignId: number,
  ): Promise<boolean | null> {
    let testId = this.state.getCopyCanaryTestId(campaignId);
    if (!testId && this.copyCanary) {
      testId = await this.copyCanary.healMissingTestId(campaignId);
    }
    if (!testId) return null;
    const splits = await this.providerSplits(String(testId));
    if (!splits.length) return null;
    return allEspsAtOrAbove(splits, this.config.remediationInboxThreshold);
  }

  /** D93 — known-good on these domains, every scored ESP at/above 80%. */
  private async knownGoodFineAcrossEsps(
    emails: string[],
  ): Promise<boolean | null> {
    const wanted = new Set(emails.map((email) => email.toLowerCase()));
    const controls = this.state
      .listPodControls()
      .filter((row) =>
        row.emails.some((email) => wanted.has(email.toLowerCase())),
      );
    if (!controls.length) return null;
    let scored = false;
    for (const row of controls) {
      if (!row.spamTestId) continue;
      const splits = await this.providerSplits(row.spamTestId);
      if (!splits.length) continue;
      scored = true;
      if (allEspsAtOrAbove(splits, this.config.remediationInboxThreshold) === false) {
        return false;
      }
    }
    return scored ? true : null;
  }

  private async providerSplits(testId: string): Promise<ProviderInboxSplit[]> {
    try {
      const report = await this.smartDelivery.getProviderwiseReport(testId);
      const rows = Array.isArray(report?.result) ? report.result : [];
      const out: ProviderInboxSplit[] = [];
      for (const row of rows) {
        const name = String(row.provider_name ?? row.provider ?? "");
        const inbox = inboxPercentFromProvider(row);
        if (!name || inbox == null) continue;
        out.push({ name, inboxPercent: inbox });
      }
      return out;
    } catch {
      return [];
    }
  }

  private async infraFromLatestControl(
    emails: string[],
  ): Promise<Record<string, unknown>> {
    const wanted = new Set(emails);
    const control = this.state
      .listPodControls()
      .find((row) => row.emails.some((email) => wanted.has(email.toLowerCase())));
    if (!control) return {};
    const testId = control.spamTestId;
    const [ip, domain, dkim, spf, rdns, ipAnalytics] = await Promise.all([
      this.smartDelivery.getIpBlacklist(testId).catch(() => null),
      this.smartDelivery.getDomainBlacklist(testId).catch(() => null),
      this.smartDelivery.getDkimDetails(testId).catch(() => null),
      this.smartDelivery.getSpfDetails(testId).catch(() => null),
      this.smartDelivery.getRdnsDetails(testId).catch(() => null),
      this.smartDelivery.getIpAnalytics(testId).catch(() => null),
    ]);
    const ipRaw = parseIpBlacklistHits(ip ?? []);
    const domainRaw = parseDomainBlacklistHits(domain);
    const ipHits = filterCountableBlacklistHits(ipRaw);
    const domainHits = filterCountableBlacklistHits(domainRaw);
    if (
      ipRaw.length + domainRaw.length > 0 &&
      ipHits.length + domainHits.length === 0
    ) {
      console.log(
        `[isolation] SURBL-only listing(s) on control ${testId} — info only, not a hit (D210)`,
      );
    }
    return {
      testId,
      ipHits: ipHits.length,
      domainHits: domainHits.length,
      dkim,
      spf,
      rdns,
      ipAnalytics,
    };
  }
}

function inboxPercentFromProvider(row: {
  inbox_rate?: number;
  inbox_count?: number;
  tab_count?: number;
  spam_count?: number;
  adjusted_total_email_count?: number;
  total_email_count?: number;
}): number | null {
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

function decidedNeedsRig(
  campaignInSpam: boolean,
  senderControls: Array<"PRIMARY" | "SPAM" | "OTHER" | "UNKNOWN">,
): boolean {
  return (
    campaignInSpam &&
    senderControls.some((placement) => placement === "PRIMARY") &&
    !senderControls.some((placement) => placement === "SPAM")
  );
}

function whyNotTheOtherCause(
  verdict: IsolationRunRecord["verdict"],
  reason: string,
): string {
  if (verdict === "COPY") {
    return "Why not the inboxes: known-good on those domains landed across ESPs, and unwarmed senders with that same copy also failed an ESP.";
  }
  if (verdict === "INFRA") {
    return "Why not the copy: either the known-good email on those domains failed an ESP, or unwarmed senders landed that campaign copy — rewriting the live email will not fix this.";
  }
  if (verdict === "HEALTHY") {
    return "Why nothing is broken: the campaign test and the known-good email both look fine.";
  }
  return `Why I will not pick a cause yet: ${reason}`;
}

function summarizeInfra(infra?: Record<string, unknown>): string | undefined {
  if (!infra) return undefined;
  const ipHits = Number(infra.ipHits ?? 0);
  const domainHits = Number(infra.domainHits ?? 0);
  if (!ipHits && !domainHits) {
    return "Inbox diagnostics did not name a blacklist. Check authentication on the standing test.";
  }
  return `Inbox diagnostics: ${ipHits} IP listing${ipHits === 1 ? "" : "s"}, ${domainHits} domain listing${domainHits === 1 ? "" : "s"}.`;
}

