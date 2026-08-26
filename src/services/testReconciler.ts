import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  isAutomatedTest,
  isTestStoppable,
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import {
  isHeldRecoveryTestName,
  isRestRecoveryTestName,
} from "./heldPlacementTests.js";
import {
  campaignIdFromCanaryTestName,
  isCanaryCopyTestName,
  isIsolationManagedTestName,
} from "../lib/isolationNames.js";

export interface StoppedTest {
  testId: string;
  testName?: string;
  campaignId: string;
  campaignStatus: string;
}

export interface TestReconcileResult {
  dryRun: boolean;
  automatedTests: number;
  stopped: StoppedTest[];
  keptActive: number;
  orphaned: string[];
  errors: string[];
}

/**
 * Keeps recurring placement tests aligned with campaign state: an automated
 * test should only keep running while its campaign is active. Runs with the
 * monitor cron so a campaign paused between scans stops billing test runs.
 *
 * Held-recovery tests (D39) are an exception: they keep running while any of
 * their mailboxes are still held, even if the sequence-shell campaign pauses.
 */
export class TestReconciler {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(): Promise<TestReconcileResult> {
    const result: TestReconcileResult = {
      dryRun: this.config.dryRun,
      automatedTests: 0,
      stopped: [],
      keptActive: 0,
      orphaned: [],
      errors: [],
    };

    if (!this.config.enableTestReconciler) {
      console.log(
        "[test-reconciler] Disabled (ENABLE_TEST_RECONCILER=false)",
      );
      return result;
    }

    console.log(
      `[test-reconciler] Starting (${result.dryRun ? "DRY RUN" : "LIVE"})`,
    );

    let tests;
    try {
      const listed = normalizeTestList(await this.smartDelivery.listTests({}));
      // List payload omits campaign_id; without enrichment every auto test is
      // treated as orphaned and never stopped when its campaign goes inactive.
      tests = await this.smartDelivery.enrichCampaignIds(listed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list tests: ${message}`);
      await this.finish(result);
      return result;
    }

    let campaignStatus: Map<string, string>;
    try {
      const campaigns = await this.smartlead.listCampaigns();
      campaignStatus = new Map(
        campaigns.map((c) => [
          String(c.id),
          String(c.status ?? "").toUpperCase(),
        ]),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Without campaign statuses we cannot safely decide what to stop.
      result.errors.push(`list campaigns: ${message}`);
      await this.finish(result);
      return result;
    }

    const activeStatuses = new Set(this.config.autoTestActiveStatuses);

    for (const test of tests) {
      if (!isAutomatedTest(test)) continue;
      result.automatedTests += 1;

      const testId = testIdOf(test);
      const campaignId =
        campaignIdOf(test) ??
        (isCanaryCopyTestName(test.test_name)
          ? campaignIdFromCanaryTestName(test.test_name)?.toString()
          : undefined);
      if (!testId) continue;

      if (!campaignId) {
        // No campaign linkage — never guess; surface instead of stopping.
        result.orphaned.push(testId);
        continue;
      }

      const status = campaignStatus.get(campaignId);
      if (status === undefined) {
        // Campaign deleted from Smartlead entirely.
        result.orphaned.push(testId);
        continue;
      }

      // D39 held-recovery tests: keep while any mailbox is still held, even if
      // the sequence-shell campaign is no longer ACTIVE.
      const heldRecord = this.state.getHeldPlacementTest(testId);
      const restRecord = this.state.getRestPlacementTest(testId);
      const isHeldRecovery =
        Boolean(heldRecord) || isHeldRecoveryTestName(test.test_name);
      const isRestRecovery =
        Boolean(restRecord) || isRestRecoveryTestName(test.test_name);
      if (isIsolationManagedTestName(test.test_name)) {
        result.keptActive += 1;
        continue;
      }
      if (isHeldRecovery) {
        const heldEmails = new Set(
          this.state.listHeldInboxes().map((h) => h.email.toLowerCase()),
        );
        const emails = heldRecord?.emails ?? [];
        const stillHeld =
          emails.length === 0
            ? heldEmails.size > 0 // name-matched without state: keep if any holds exist
            : emails.some((e) => heldEmails.has(e.toLowerCase()));
        if (stillHeld) {
          result.keptActive += 1;
          continue;
        }
        // No longer held — fall through to stop (free the quota slot).
      } else if (isRestRecovery) {
        const restEmails = new Set(
          this.state.listRestingInboxes().map((h) => h.email.toLowerCase()),
        );
        const emails = restRecord?.emails ?? [];
        const stillResting =
          emails.length === 0
            ? restEmails.size > 0
            : emails.some((e) => restEmails.has(e.toLowerCase()));
        if (stillResting) {
          result.keptActive += 1;
          continue;
        }
      } else if (activeStatuses.has(status)) {
        result.keptActive += 1;
        continue;
      }

      if (!isTestStoppable(test)) continue;

      const dedupeKey = `stop-auto-test:${testId}`;
      if (this.state.hasRemediation(dedupeKey)) continue;

      try {
        if (!result.dryRun) {
          await this.smartDelivery.stopAutomatedTest(testId);
          this.state.markRemediation(dedupeKey);
          await sleep(300);
        }
        result.stopped.push({
          testId,
          testName: test.test_name,
          campaignId,
          campaignStatus: status || "(unknown)",
        });
        console.log(
          `[test-reconciler] Stopped recurring test ${testId} — campaign ${campaignId} is ${status}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`stop test ${testId}: ${message}`);
      }
    }

    await this.finish(result);
    return result;
  }

  private async finish(result: TestReconcileResult): Promise<void> {
    await this.state.save();
    console.log("[test-reconciler] Done", {
      dryRun: result.dryRun,
      automatedTests: result.automatedTests,
      stopped: result.stopped.length,
      keptActive: result.keptActive,
      orphaned: result.orphaned.length,
      errors: result.errors.length,
    });

    if (result.stopped.length || result.errors.length) {
      await this.slack
        .notifyTestReconcile(result)
        .catch((error) => {
          console.error("[test-reconciler] Slack notify failed", error);
        });
    }
  }
}
