import { randomUUID } from "node:crypto";
import { INBOX_THRESHOLD, ISOLATION_DEADLINE_MS } from "../canon/constants.js";
import type { AppConfig } from "../config.js";
import {
  decideIsolationVerdict,
  duplicateCanaryTests,
  filterFleetSenderRows,
  isolationOverdue,
  liveCampaignForTest,
  minSameEspInbox,
  pickLivingCanaryTest,
  prioritizeCampaigns,
  sameEspSplits,
  shouldQueueUglyScore,
  uglyWithoutIsolation,
} from "../lib/isolation.js";
import { canaryCopyTestName, matchesAutoPlacementName } from "../lib/names.js";
import { isActiveStatus } from "../lib/staffable.js";
import type { WriteGate } from "../shadow.js";
import type { V2Store } from "../store.js";
import type {
  Finding,
  IntendedAction,
  InventoryBook,
  IsolationRun,
  PlacementScore,
  SpamTest,
} from "../types.js";

export interface IsolationTickResult {
  findings: Finding[];
  intended: IntendedAction[];
  scored: number;
  queued: number;
  evaluated: number;
  overdue: number;
}

export async function runIsolationTick(opts: {
  book: InventoryBook;
  tests: SpamTest[];
  fleetEmails: readonly string[];
  gate: WriteGate;
  store: V2Store;
  config: AppConfig;
  now?: Date;
}): Promise<IsolationTickResult> {
  const now = opts.now ?? new Date();
  const findings: Finding[] = [];
  const intended: IntendedAction[] = [];
  let queued = 0;
  let evaluated = 0;
  let overdue = 0;

  const existingScores = await opts.store.listScores();
  const suspects = await opts.store.listSuspects();
  const latestBy = new Map<number, IsolationRun>();
  for (const campaign of opts.book.campaigns) {
    const run = await opts.store.latestRun(campaign.id);
    if (run) latestBy.set(campaign.id, run);
  }

  const scores: PlacementScore[] = [];
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

    const copyTest = pickLivingCanaryTest(canaries, campaign.id);
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

    const test = copyTest ?? opts.tests.find((t) => matchesAutoPlacementName(t.name, campaign.name));
    if (!test) continue;

    const mapped = liveCampaignForTest({ testName: test.name, campaigns: opts.book.campaigns });
    if (!mapped) continue;

    const { kept, releasedIgnored } = filterFleetSenderRows(test.senders ?? [], opts.fleetEmails);
    if (!kept.length) continue;
    const splits = sameEspSplits(kept);
    const inbox = minSameEspInbox(splits);
    if (inbox == null) continue;
    const score: PlacementScore = {
      campaignId: mapped.campaign.id,
      campaignName: mapped.campaign.name,
      source: mapped.source,
      testId: test.id,
      inboxPercent: inbox,
      scoredAt: now.toISOString(),
      fleetEmailsScored: kept.length,
      releasedEmailsIgnored: releasedIgnored,
    };
    scores.push(score);
    await opts.store.upsertScore(score);

    const suspect = suspects.find((s) => s.campaignId === score.campaignId);
    const run = latestBy.get(score.campaignId);
    if (shouldQueueUglyScore({ score, suspect, run })) {
      queued += 1;
      await opts.store.upsertSuspect({
        campaignId: score.campaignId,
        campaignName: score.campaignName,
        source: score.source,
        testId: score.testId,
        queuedAt: now.toISOString(),
      });
      intended.push(
        (
          await opts.gate.intend({
            kind: "isolate",
            campaignId: score.campaignId,
            payload: { source: score.source, inboxPercent: score.inboxPercent, testId: score.testId },
            run: async () => undefined,
          })
        ).action,
      );

      const warmed = opts.tests.find((t) => matchesAutoPlacementName(t.name, campaign.name));
      const warmedSenders = warmed?.senders ?? [];
      const warmedInbox = warmedSenders.filter((s) => s.inbox).length;
      const copyInbox = kept.filter((s) => s.inbox).length;
      const verdict = decideIsolationVerdict({
        copyCanary: {
          unwarmedLanded: kept.length ? copyInbox * 2 >= kept.length : null,
          warmedLanded: warmedSenders.length ? warmedInbox * 2 >= warmedSenders.length : null,
          unwarmedTested: kept.length,
          warmedTested: warmedSenders.length,
        },
        unwarmedCopyFineAcrossEsps: inbox >= INBOX_THRESHOLD ? true : false,
      });
      evaluated += 1;
      const runRow: IsolationRun = {
        id: randomUUID(),
        campaignId: score.campaignId,
        verdict: verdict.verdict,
        reason: verdict.reason,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        teardownStarted: verdict.startCopyTeardown,
      };
      await opts.store.insertRun(runRow);
      await opts.store.upsertSuspect({
        campaignId: score.campaignId,
        campaignName: score.campaignName,
        source: score.source,
        testId: score.testId,
        queuedAt: now.toISOString(),
        evaluatedAt: now.toISOString(),
      });
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
      detail: `${hole.campaignName ?? hole.campaignId} ${hole.inboxPercent}% ${hole.source}`,
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

  return { findings, intended, scored: scores.length, queued, evaluated, overdue };
}

export async function loadTestsOrThrow(
  listTests: () => Promise<SpamTest[]>,
): Promise<SpamTest[]> {
  return listTests();
}
