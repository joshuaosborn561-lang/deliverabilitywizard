import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  isTestStoppable,
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";

export interface StoppedTest {
  testId: string;
  testName?: string;
  campaignId: string;
  campaignStatus: string;
}

export interface DeletedTest {
  testId: string;
  testName?: string;
  campaignId?: string;
  campaignStatus: string;
  reason: "inactive_campaign" | "missing_campaign";
}

export interface TestReconcileResult {
  dryRun: boolean;
  listedTests: number;
  stopped: StoppedTest[];
  deleted: DeletedTest[];
  keptActive: number;
  errors: string[];
}

/**
 * Keeps placement tests aligned with campaign state: any test whose campaign
 * is not ACTIVE (or cannot be linked) is stopped if still living, then
 * deleted. Runs with the monitor cron so dead campaigns do not leave junk
 * tests in SmartDelivery.
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
      listedTests: 0,
      stopped: [],
      deleted: [],
      keptActive: 0,
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
      // List payload omits campaign_id; enrich every row so inactive-campaign
      // deletes cannot be skipped as "orphans".
      tests = await this.smartDelivery.enrichCampaignIds(listed);
      result.listedTests = tests.length;
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
      // Without campaign statuses we cannot safely decide what to delete.
      result.errors.push(`list campaigns: ${message}`);
      await this.finish(result);
      return result;
    }

    const activeStatuses = new Set(this.config.autoTestActiveStatuses);
    const toDelete: DeletedTest[] = [];

    for (const test of tests) {
      const testId = testIdOf(test);
      if (!testId) continue;

      const campaignId = campaignIdOf(test);
      if (!campaignId) {
        toDelete.push({
          testId,
          testName: test.test_name,
          campaignStatus: "(no campaign_id)",
          reason: "missing_campaign",
        });
        continue;
      }

      const status = campaignStatus.get(campaignId);
      if (status === undefined) {
        toDelete.push({
          testId,
          testName: test.test_name,
          campaignId,
          campaignStatus: "(missing from Smartlead)",
          reason: "missing_campaign",
        });
        continue;
      }

      if (activeStatuses.has(status)) {
        result.keptActive += 1;
        continue;
      }

      // Inactive campaign — stop if still living, then delete.
      if (isTestStoppable(test)) {
        const stopKey = `stop-auto-test:${testId}`;
        if (!this.state.hasRemediation(stopKey)) {
          try {
            if (!result.dryRun) {
              await this.smartDelivery.stopAutomatedTest(testId);
              this.state.markRemediation(stopKey);
              await sleep(300);
            }
            result.stopped.push({
              testId,
              testName: test.test_name,
              campaignId,
              campaignStatus: status || "(unknown)",
            });
            console.log(
              `[test-reconciler] Stopped test ${testId} — campaign ${campaignId} is ${status}`,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            // Already stopped / not in progress is fine — still delete.
            if (!/not in progress|already stop/i.test(message)) {
              result.errors.push(`stop test ${testId}: ${message}`);
            }
          }
        }
      }

      toDelete.push({
        testId,
        testName: test.test_name,
        campaignId,
        campaignStatus: status || "(unknown)",
        reason: "inactive_campaign",
      });
    }

    const deleteIds: string[] = [];
    for (const row of toDelete) {
      const dedupeKey = `delete-test:${row.testId}`;
      if (this.state.hasRemediation(dedupeKey)) continue;
      deleteIds.push(row.testId);
    }

    if (deleteIds.length) {
      try {
        if (!result.dryRun) {
          // Bulk delete in chunks — SmartDelivery accepts spamTestIds arrays.
          for (let i = 0; i < deleteIds.length; i += 25) {
            const chunk = deleteIds.slice(i, i + 25);
            await this.smartDelivery.deleteTests(chunk);
            for (const id of chunk) {
              this.state.markRemediation(`delete-test:${id}`);
            }
            await sleep(300);
          }
        }
        for (const row of toDelete) {
          if (!deleteIds.includes(row.testId)) continue;
          result.deleted.push(row);
          console.log(
            `[test-reconciler] Deleted test ${row.testId} — ${row.reason} (${row.campaignStatus})`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`delete tests: ${message}`);
      }
    }

    await this.finish(result);
    return result;
  }

  private async finish(result: TestReconcileResult): Promise<void> {
    await this.state.save();
    console.log("[test-reconciler] Done", {
      dryRun: result.dryRun,
      listedTests: result.listedTests,
      stopped: result.stopped.length,
      deleted: result.deleted.length,
      keptActive: result.keptActive,
      errors: result.errors.length,
    });

    if (
      result.stopped.length ||
      result.deleted.length ||
      result.errors.length
    ) {
      await this.slack
        .notifyTestReconcile(result)
        .catch((error) => {
          console.error("[test-reconciler] Slack notify failed", error);
        });
    }
  }
}
