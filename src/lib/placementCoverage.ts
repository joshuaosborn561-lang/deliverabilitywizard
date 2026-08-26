import {
  campaignIdOf,
  isAutomatedTest,
  isTestStoppable,
  testIdOf,
} from "../clients/smartdelivery.js";
import type { SpamTestSummary } from "../types/index.js";
import type { TestedCampaignRecord } from "../state/store.js";

/**
 * Campaigns that currently have a stoppable automated placement test.
 * Completed/manual/historical linkage must not count as coverage (and must
 * not block the scanner from creating a real recurring test).
 */
export function campaignsWithActiveAutos(
  tests: SpamTestSummary[],
): Set<string> {
  const out = new Set<string>();
  for (const test of tests) {
    if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
    const cid = campaignIdOf(test);
    if (cid) out.add(cid);
  }
  return out;
}

/** Ids of stoppable automated tests from a list payload. */
export function stoppableAutoTestIds(tests: SpamTestSummary[]): Set<string> {
  const out = new Set<string>();
  for (const test of tests) {
    if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
    const id = testIdOf(test);
    if (id) out.add(id);
  }
  return out;
}

/**
 * Merge live ACTIVE-auto coverage with state marks that still point at a
 * living stoppable auto test id. Stale state (completed manuals) is ignored.
 */
export function testedCampaignCoverage(
  tests: SpamTestSummary[],
  testedCampaigns: Record<string, TestedCampaignRecord | undefined>,
): Set<string> {
  const covered = campaignsWithActiveAutos(tests);
  const livingTestIds = stoppableAutoTestIds(tests);
  const livingCampaignByTestId = new Map<string, string>();
  for (const test of tests) {
    if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
    const id = testIdOf(test);
    const cid = campaignIdOf(test);
    if (id && cid) livingCampaignByTestId.set(String(id), cid);
  }
  for (const [campaignId, record] of Object.entries(testedCampaigns)) {
    if (!record?.testIds?.length) continue;
    // D121 — a living test for a *different* campaign does not cover this one.
    // Live 2026-08-26: scanner skipped #3847844/#3847845 (eligible=0) while
    // campaign-check still stamped no_placement_test.
    // D123 — enrichCampaignIds 429s mid-list (~300 tests). A living id
    // with no campaign_id still covers the campaign we stored it on, so
    // check and scan do not disagree. A living id whose campaign_id is
    // someone else still does not cover.
    if (
      record.testIds.some((id) => {
        // D121 — keep this exact match; a sibling's living test is not coverage.
        if (livingCampaignByTestId.get(String(id)) === String(campaignId)) {
          return true;
        }
        const key = String(id);
        const livingCid = livingCampaignByTestId.get(key);
        return livingCid === undefined && livingTestIds.has(key);
      })
    ) {
      covered.add(campaignId);
    }
  }
  return covered;
}
