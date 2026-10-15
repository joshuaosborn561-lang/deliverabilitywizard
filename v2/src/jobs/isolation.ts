import { randomUUID } from "node:crypto";
import {
  COPY_CANARY_FLEET_SIZE,
  INBOX_THRESHOLD,
  ISOLATION_DEADLINE_MS,
  LAUNCH_BAR,
} from "../canon/constants.js";
import type { AppConfig } from "../config.js";
import { chicagoYmd } from "../clients/inboxkit.js";
import { toEspInboxDay } from "../lib/espMatrix.js";
import {
  canaryKindForSource,
  classifyCanaryFailure,
  decideIsolationVerdict,
  duplicateCanaryTests,
  isolationOverdue,
  liveCampaignForTest,
  pickLivingCanaryTest,
  prioritizeCampaigns,
  scoreInputsForTest,
  shouldQueueUglyScore,
  uglyWithoutIsolation,
} from "../lib/isolation.js";
import {
  canaryCopyTestName,
  isCanaryCopyTestName,
  matchesAutoPlacementName,
} from "../lib/names.js";
import { huntCopyWords, wordHuntSlackPayload } from "../lib/wordHunt.js";
import { burnedRetireReason } from "../lib/retireReason.js";
import { isActiveStatus } from "../lib/staffable.js";
import { intendSpend } from "./spend.js";
import { runQaTick } from "./qa.js";
import type { WriteGate } from "../shadow.js";
import type { V2Store } from "../store.js";
import type {
  Finding,
  IntendedAction,
  InventoryBook,
  IsolationRun,
  LeadSample,
  PlacementScore,
  SequenceSample,
  SpamTest,
} from "../types.js";

export interface IsolationTickResult {
  findings: Finding[];
  intended: IntendedAction[];
  scored: number;
  queued: number;
  evaluated: number;
  overdue: number;
  wordHunts: number;
}

export async function runIsolationTick(opts: {
  book: InventoryBook;
  tests: SpamTest[];
  fleetEmails: readonly string[];
  gate: WriteGate;
  store: V2Store;
  config: AppConfig;
  now?: Date;
  sequences?: SequenceSample[];
  leads?: LeadSample[];
  runQa?: boolean;
}): Promise<IsolationTickResult> {
  const now = opts.now ?? new Date();
  const findings: Finding[] = [];
  const intended: IntendedAction[] = [];
  let queued = 0;
  let evaluated = 0;
  let overdue = 0;
  let wordHunts = 0;

  const existingScores = await opts.store.listScores();
  const suspects = await opts.store.listSuspects();
  const latestBy = new Map<number, IsolationRun>();
  for (const campaign of opts.book.campaigns) {
    const run = await opts.store.latestRun(campaign.id);
    if (run) latestBy.set(campaign.id, run);
  }

  const scores: PlacementScore[] = [];
  const copyUgly = new Map<number, PlacementScore>();
  const senderUgly = new Map<number, PlacementScore>();
  const copyInboxByCampaign = new Map<number, { inbox: number; total: number }>();
  const warmedInboxByCampaign = new Map<number, { inbox: number; total: number }>();

  const priority = prioritizeCampaigns({
    campaigns: opts.book.campaigns,
    scores: existingScores,
    ugly: uglyWithoutIsolation({
      scores: existingScores,
      suspects,
      latestRun: (id) => latestBy.get(id),
      keepCampaignId: (id) =>
        opts.book.campaigns.some((c) => c.id === id && isActiveStatus(c.status)),
    }),
  });

  if (opts.fleetEmails.length < COPY_CANARY_FLEET_SIZE) {
    intended.push(
      await intendSpend(
        {
          id: `canary-fleet-${chicagoYmd(now)}`,
          kind: "buy_mailboxes",
          amountUsd: opts.config.spendCapDomainUsd,
          payload: {
            reason: "living canary fleet is under 10 seats",
            have: opts.fleetEmails.length,
            want: COPY_CANARY_FLEET_SIZE,
          },
        },
        opts.gate,
        opts.config,
      ),
    );
  }

  for (const campaign of priority) {
    const canaries = duplicateCanaryTests(opts.tests, campaign.id);
    if (canaries.length > 1) {
      findings.push({
        kind: "duplicate_canary_test",
        campaignId: campaign.id,
        detail: `${canaries.length} Canary copy tests for #${campaign.id} (want 1)`,
      });
      const keep = pickLivingCanaryTest(canaries, campaign.id);
      for (const extra of canaries) {
        if (keep && extra.id === keep.id) continue;
        intended.push(
          (
            await opts.gate.intend({
              kind: "test_stop",
              campaignId: campaign.id,
              payload: { testId: extra.id, testName: extra.name, reason: "duplicate_canary" },
              run: async () => undefined,
            })
          ).action,
        );
      }
    }

    const copyTest =
      pickLivingCanaryTest(canaries, campaign.id) ??
      opts.tests.find(
        (t) => Number(t.campaignId) === campaign.id && isCanaryCopyTestName(t.name),
      );
    if (!copyTest && isActiveStatus(campaign.status)) {
      findings.push({
        kind: "missing_canary",
        campaignId: campaign.id,
        detail: `no living ${canaryCopyTestName(campaign.id)}`,
      });
      intended.push(
        (
          await opts.gate.intend({
            kind: "test_create",
            campaignId: campaign.id,
            payload: { name: canaryCopyTestName(campaign.id, campaign.name) },
            run: async () => undefined,
          })
        ).action,
      );
    }

    const warmedTest = opts.tests.find(
      (t) =>
        matchesAutoPlacementName(t.name, campaign.name) ||
        (Number(t.campaignId) === campaign.id && !isCanaryCopyTestName(t.name)),
    );

    if (copyTest) {
      const mapped = liveCampaignForTest({
        testName: copyTest.name,
        campaignId: copyTest.campaignId,
        campaigns: opts.book.campaigns,
      });
      if (mapped) {
        const scored = scoreInputsForTest({
          test: copyTest,
          source: "canary-copy",
          fleetEmails: opts.fleetEmails,
        });
        if (scored) {
          const kind = canaryKindForSource("canary-copy");
          const failureClass = classifyCanaryFailure({ kind, inboxPercent: scored.inbox });
          const score: PlacementScore = {
            campaignId: mapped.campaign.id,
            campaignName: mapped.campaign.name,
            source: "canary-copy",
            testId: copyTest.id,
            inboxPercent: scored.inbox,
            scoredAt: now.toISOString(),
            fleetEmailsScored: scored.senders.length,
            releasedEmailsIgnored: scored.releasedIgnored,
            canaryKind: kind,
            failureClass,
          };
          scores.push(score);
          copyInboxByCampaign.set(mapped.campaign.id, {
            inbox: scored.senders.filter((s) => s.inbox).length,
            total: scored.senders.length || 1,
          });
          await opts.store.upsertScore(score);
          if (scored.senders.length) {
            await opts.store.recordEspMatrix(
              toEspInboxDay({
                campaignId: mapped.campaign.id,
                campaignName: mapped.campaign.name,
                day: chicagoYmd(now),
                senders: scored.senders,
                testId: copyTest.id,
                source: "canary-copy",
              }),
            );
          }
          if (failureClass === "copy") copyUgly.set(mapped.campaign.id, score);
        }
      }
    }

    if (warmedTest) {
      const mapped = liveCampaignForTest({
        testName: warmedTest.name,
        campaignId: warmedTest.campaignId,
        campaigns: opts.book.campaigns,
      });
      if (mapped) {
        const scored = scoreInputsForTest({
          test: warmedTest,
          source: "live-placement",
          fleetEmails: opts.fleetEmails,
        });
        if (scored) {
          const kind = canaryKindForSource("live-placement");
          const failureClass = classifyCanaryFailure({ kind, inboxPercent: scored.inbox });
          const score: PlacementScore = {
            campaignId: mapped.campaign.id,
            campaignName: mapped.campaign.name,
            source: "live-placement",
            testId: warmedTest.id,
            inboxPercent: scored.inbox,
            scoredAt: now.toISOString(),
            fleetEmailsScored: scored.senders.length,
            releasedEmailsIgnored: scored.releasedIgnored,
            canaryKind: kind,
            failureClass,
          };
          scores.push(score);
          warmedInboxByCampaign.set(mapped.campaign.id, {
            inbox: scored.senders.filter((s) => s.inbox).length,
            total: scored.senders.length || 1,
          });
          await opts.store.upsertScore(score);
          if (scored.senders.length) {
            await opts.store.recordEspMatrix(
              toEspInboxDay({
                campaignId: mapped.campaign.id,
                campaignName: mapped.campaign.name,
                day: chicagoYmd(now),
                senders: scored.senders,
                testId: warmedTest.id,
                source: "live-placement",
              }),
            );
          }
          if (failureClass === "sender") senderUgly.set(mapped.campaign.id, score);
          if (score.inboxPercent < LAUNCH_BAR) {
            findings.push({
              kind: "below_launch_bar",
              campaignId: mapped.campaign.id,
              detail: `${mapped.campaign.name} ${score.inboxPercent.toFixed(0)}% inbox (bar ${LAUNCH_BAR}%)`,
            });
          }
        }
      }
    }

    const uglyScore = copyUgly.get(campaign.id) ?? senderUgly.get(campaign.id);
    if (!uglyScore) continue;
    const suspect = suspects.find((s) => s.campaignId === uglyScore.campaignId);
    const run = latestBy.get(uglyScore.campaignId);
    if (!shouldQueueUglyScore({ score: uglyScore, suspect, run })) continue;

    queued += 1;
    await opts.store.upsertSuspect({
      campaignId: uglyScore.campaignId,
      campaignName: uglyScore.campaignName,
      source: uglyScore.source,
      testId: uglyScore.testId,
      queuedAt: now.toISOString(),
    });
    intended.push(
      (
        await opts.gate.intend({
          kind: "isolate",
          campaignId: uglyScore.campaignId,
          payload: {
            source: uglyScore.source,
            inboxPercent: uglyScore.inboxPercent,
            testId: uglyScore.testId,
            failureClass: uglyScore.failureClass,
            canaryKind: uglyScore.canaryKind,
          },
          run: async () => undefined,
        })
      ).action,
    );

    const copySplit = copyInboxByCampaign.get(campaign.id);
    const warmSplit = warmedInboxByCampaign.get(campaign.id);
    const verdict = decideIsolationVerdict({
      copyCanary: {
        unwarmedLanded: copySplit ? copySplit.inbox * 2 >= copySplit.total : null,
        warmedLanded: warmSplit ? warmSplit.inbox * 2 >= warmSplit.total : null,
        unwarmedTested: copySplit?.total ?? 0,
        warmedTested: warmSplit?.total ?? 0,
      },
      unwarmedCopyFineAcrossEsps: copySplit
        ? ((copySplit.inbox / copySplit.total) * 100 >= INBOX_THRESHOLD)
        : undefined,
    });
    evaluated += 1;
    const runRow: IsolationRun = {
      id: randomUUID(),
      campaignId: uglyScore.campaignId,
      verdict: verdict.verdict,
      reason: verdict.reason,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      teardownStarted: verdict.startCopyTeardown,
    };
    await opts.store.insertRun(runRow);
    latestBy.set(campaign.id, runRow);
    await opts.store.upsertSuspect({
      campaignId: uglyScore.campaignId,
      campaignName: uglyScore.campaignName,
      source: uglyScore.source,
      testId: uglyScore.testId,
      queuedAt: now.toISOString(),
      evaluatedAt: now.toISOString(),
    });

    if (verdict.verdict === "COPY" || uglyScore.failureClass === "copy") {
      const body =
        opts.sequences?.find((s) => s.campaignId === campaign.id)?.body ?? "";
      const hits = huntCopyWords(body);
      wordHunts += hits.length ? 1 : 0;
      for (const hit of hits) {
        intended.push(
          (
            await opts.gate.intend({
              kind: "word_hunt",
              campaignId: campaign.id,
              payload: {
                phrase: hit.phrase,
                swap: hit.swap,
                job: hit.job,
                reason: "copy_canary_fail",
              },
              run: async () => undefined,
            })
          ).action,
        );
        intended.push(
          (
            await opts.gate.intend({
              kind: "slack",
              campaignId: campaign.id,
              payload: wordHuntSlackPayload(hit, campaign.name),
              run: async () => undefined,
            })
          ).action,
        );
      }
      if (verdict.startCopyTeardown) {
        intended.push(
          (
            await opts.gate.intend({
              kind: "sequence_write",
              campaignId: campaign.id,
              payload: { reason: "copy_teardown_intended", hits },
              run: async () => undefined,
            })
          ).action,
        );
      }
    }

    if (verdict.verdict === "INFRA" || uglyScore.failureClass === "sender") {
      const domain = (opts.book.accounts.find((a) => a.campaignIds.includes(campaign.id))?.email ?? "")
        .split("@")[1] ?? campaign.name;
      const reason = burnedRetireReason({
        domain,
        isolationVerdict: verdict.verdict === "INFRA" ? "INFRA" : undefined,
      });
      intended.push(
        await intendSpend(
          {
            id: `retire-${domain}-${campaign.id}`,
            kind: "retire_domain",
            clientId: campaign.clientId ?? undefined,
            amountUsd: opts.config.spendCapDomainUsd,
            payload: { domain, reason, failureClass: uglyScore.failureClass },
          },
          opts.gate,
          opts.config,
        ),
      );
    }
  }

  const allScores = scores.length ? scores : existingScores;
  const holes = uglyWithoutIsolation({
    scores: allScores,
    suspects: await opts.store.listSuspects(),
    latestRun: (id) => latestBy.get(id),
    keepCampaignId: (id) => opts.book.campaigns.some((c) => c.id === id && isActiveStatus(c.status)),
  });
  for (const hole of holes) {
    findings.push({
      kind: "ugly_without_isolation",
      campaignId: hole.campaignId,
      detail: `${hole.campaignName ?? hole.campaignId} ${hole.inboxPercent}% ${hole.source} ${hole.failureClass ?? ""}`.trim(),
    });
    if (isolationOverdue(hole.scoredAt, now.getTime(), opts.config.isolationDeadlineMs)) {
      overdue += 1;
      findings.push({
        kind: "isolation_deadline",
        campaignId: hole.campaignId,
        detail: `uglyWithoutIsolation older than ${ISOLATION_DEADLINE_MS / 60000} minutes`,
      });
      intended.push(
        (
          await opts.gate.intend({
            kind: "slack",
            campaignId: hole.campaignId,
            payload: { kind: "ops_alert", reason: "isolation_deadline" },
            run: async () => undefined,
          })
        ).action,
      );
    }
  }

  if (opts.runQa !== false) {
    try {
      const qa = await runQaTick({
        book: opts.book,
        role: "isolation",
        trigger: "scheduled",
        store: opts.store,
        gate: opts.gate,
        sequences: opts.sequences,
        leads: opts.leads,
        now,
      });
      findings.push(...qa.findings);
      intended.push(...qa.intended);
    } catch {
      /* placement findings still ship if QA ledger write fails */
    }
  }

  return { findings, intended, scored: scores.length, queued, evaluated, overdue, wordHunts };
}

export async function loadTestsOrThrow(
  listTests: () => Promise<SpamTest[]>,
): Promise<SpamTest[]> {
  return listTests();
}
