import {
  isAutomatedTest,
  isTestStoppable,
  testIdOf,
} from "../clients/smartdelivery.js";
import type { SpamTestSummary } from "../types/index.js";
import type { PodControlRecord } from "../state/isolationState.js";
import {
  campaignIdFromCanaryTestName,
  isCanaryCopyTestName,
  isPodControlTestName,
} from "./isolationNames.js";

/**
 * D82 — serving inboxes must sit on a living known-good (pod-control) test.
 * Stored pod-control rows count only when that test is still stoppable.
 */
export function livingKnownGoodEmails(
  tests: SpamTestSummary[],
  podControls: Array<Pick<PodControlRecord, "spamTestId" | "emails">>,
): Set<string> {
  const livingIds = new Set<string>();
  for (const test of tests) {
    if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
    if (!isPodControlTestName(test.test_name)) continue;
    const id = testIdOf(test);
    if (id) livingIds.add(String(id));
  }
  const out = new Set<string>();
  for (const record of podControls) {
    const id = String(record.spamTestId ?? "");
    if (!id || (livingIds.size > 0 && !livingIds.has(id))) continue;
    if (livingIds.size === 0) continue;
    for (const email of record.emails ?? []) {
      const lower = email.trim().toLowerCase();
      if (lower) out.add(lower);
    }
  }
  return out;
}

/** Living Canary copy: #id test for this campaign (unwarmed fleet senders). */
export function hasLivingUnwarmedCopyCanary(
  campaignId: number,
  tests: SpamTestSummary[],
  storedTestId?: string | number | null,
): boolean {
  const stored = storedTestId != null ? String(storedTestId) : "";
  for (const test of tests) {
    if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
    const id = testIdOf(test);
    const named = campaignIdFromCanaryTestName(test.test_name);
    if (named === campaignId) return true;
    if (stored && id && String(id) === stored && isCanaryCopyTestName(test.test_name)) {
      return true;
    }
  }
  return false;
}
