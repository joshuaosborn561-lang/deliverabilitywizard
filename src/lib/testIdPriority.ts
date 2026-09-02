import {
  isAutomatedTest,
  isTestStoppable,
  testIdOf,
} from "../clients/smartdelivery.js";
import type { SpamTestSummary } from "../types/index.js";

/** Soft cap for SmartDelivery report fan-out per remediation/monitor pass. */
export const DEFAULT_REPORT_TEST_LIMIT = 100;

/**
 * Choose which tracked SmartDelivery test ids to fetch reports for.
 *
 * Production previously took `testIds.slice(0, 40)` in insertion order, which
 * kept old COMPLETED manuals and dropped the newest ACTIVE autos (e.g. entire
 * BCP Logistics / PE campaigns after the 2026-08-05 backfill). Prefer live
 * automated tests, then newest ids, and raise the default cap so a full
 * recurring fleet fits in one pass.
 */
export function prioritizeTestIdsForReports(opts: {
  trackedIds: Iterable<string>;
  listedTests?: SpamTestSummary[];
  /** Pin these (ACTIVE live + copy-canary ids) inside the cap first. */
  priorityIds?: Iterable<string>;
  limit?: number;
}): string[] {
  const limit = opts.limit ?? DEFAULT_REPORT_TEST_LIMIT;
  const listedById = new Map<string, SpamTestSummary>();
  for (const test of opts.listedTests ?? []) {
    const id = testIdOf(test);
    if (id) listedById.set(id, test);
  }
  const priority = new Set(
    [...(opts.priorityIds ?? [])].map(String).filter(Boolean),
  );

  const unique = [...new Set([...opts.trackedIds].map(String).filter(Boolean))];

  const rank = (id: string): [number, number] => {
    const test = listedById.get(id);
    const numeric = Number(id);
    const newest = Number.isFinite(numeric) ? -numeric : 0;
    const pinned = priority.has(id);
    if (pinned && !test) {
      // copyCanaries ids often never appear in listTests / testedCampaigns.
      return [-2, newest];
    }
    if (!test) {
      // Unknown to the list — assume newer numeric ids are the live backfill.
      return [2, newest];
    }
    const auto = isAutomatedTest(test);
    const live = isTestStoppable(test);
    if (pinned && auto && live) return [-2, newest];
    if (pinned && live) return [-1, newest];
    if (pinned) return [0, newest];
    if (auto && live) return [1, newest];
    if (live) return [2, newest];
    if (auto) return [3, newest];
    return [4, newest];
  };

  return unique
    .sort((a, b) => {
      const [ra, na] = rank(a);
      const [rb, nb] = rank(b);
      if (ra !== rb) return ra - rb;
      if (na !== nb) return na - nb;
      return a.localeCompare(b);
    })
    .slice(0, Math.max(0, limit));
}
