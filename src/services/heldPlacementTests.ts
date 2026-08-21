import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  pickSequence,
  sequenceMappingIdOf,
  sequenceSubjectPreview,
} from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  isAutomatedTest,
  isTestStoppable,
  normalizeTestList,
} from "../clients/smartdelivery.js";
import { chunkArray, sleep } from "../lib/http.js";
import {
  OPEN_ENDED_TEST_DAYS,
  addDaysIso,
  paddedScheduleDate,
  schedulerCronValue,
} from "./campaignScanner.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

/**
 * D39 — Separate SmartDelivery tests for mailboxes held / pulled off live
 * campaigns. They must not be re-attached to campaigns just to earn a score;
 * these tests use a live campaign only as the sequence shell and list the
 * held emails as `sender_accounts`.
 */

export const HELD_TEST_NAME_PREFIX = "Held recovery:";
export const REST_TEST_NAME_PREFIX = "Rest recovery:";

export interface HeldPlacementTestResult {
  dryRun: boolean;
  heldMailboxes: number;
  created: string[];
  stopped: string[];
  kept: number;
  skipped: string[];
  errors: string[];
  quotaBlocked: boolean;
}

function addDaysIsoLocal(from: Date, days: number): string {
  return addDaysIso(from, days);
}

export class HeldPlacementTestService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<HeldPlacementTestResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: HeldPlacementTestResult = {
      dryRun,
      heldMailboxes: 0,
      created: [],
      stopped: [],
      kept: 0,
      skipped: [],
      errors: [],
      quotaBlocked: false,
    };

    if (!this.config.enableHeldPlacementTests) {
      console.log(
        "[held-tests] Disabled (ENABLE_HELD_PLACEMENT_TESTS=false)",
      );
      return result;
    }

    const held = this.state.listHeldInboxes();
    result.heldMailboxes = held.length;
    const heldEmails = new Set(held.map((h) => h.email.toLowerCase()));

    // Stop tests whose every mailbox has left the hold set.
    for (const row of this.state.listHeldPlacementTests()) {
      const still = row.emails.some((e) => heldEmails.has(e.toLowerCase()));
      if (still) {
        result.kept += 1;
        continue;
      }
      try {
        if (!dryRun) {
          await this.smartDelivery.stopAutomatedTest(row.testId);
          this.state.clearHeldPlacementTest(row.testId);
        }
        result.stopped.push(row.testId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`stop ${row.testId}: ${message}`);
      }
      await sleep(200);
    }

    if (!held.length) {
      console.log(
        `[held-tests] No held mailboxes; stopped=${result.stopped.length}`,
      );
      await this.state.save();
      return result;
    }

    // Emails already covered by a living held-recovery test.
    const covered = new Set<string>();
    for (const row of this.state.listHeldPlacementTests()) {
      for (const email of row.emails) covered.add(email.toLowerCase());
    }

    const uncovered = held.filter(
      (h) => !covered.has(h.email.toLowerCase()),
    );
    if (!uncovered.length) {
      console.log(
        `[held-tests] All ${held.length} held mailbox(es) already on a recovery test`,
      );
      await this.state.save();
      return result;
    }

    const [campaigns, existingRaw] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartDelivery.listTests({}).catch(() => []),
    ]);
    const existing = normalizeTestList(existingRaw);
    const used = existing.filter(
      (t) => isAutomatedTest(t) && isTestStoppable(t),
    ).length;
    const remaining = Math.max(0, this.config.totalTestQuota - used);

    const batches = chunkArray(uncovered, this.config.maxMailboxesPerTest);
    if (batches.length > remaining) {
      result.quotaBlocked = true;
      result.skipped.push(
        `quota: need ${batches.length} held-recovery test(s), only ${remaining} slot(s) left`,
      );
      await this.slack
        .notifyQuotaBlocked({
          used,
          quota: this.config.totalTestQuota,
          needed: batches.length,
          campaigns: [
            {
              id: 0,
              name: "Held recovery (off-campaign)",
              testsNeeded: batches.length,
            },
          ],
        })
        .catch(() => undefined);
      await this.state.save();
      return result;
    }

    const providerIds = this.config.providerIds;

    for (const batch of batches) {
      const shell = await this.pickShellCampaign(batch, campaigns);
      if (!shell) {
        result.skipped.push(
          `no sequence shell for ${batch.map((b) => b.email).join(",")}`,
        );
        continue;
      }

      const sequences = await this.smartlead
        .getCampaignSequences(shell.campaignId)
        .catch(() => []);
      const sequence = pickSequence(sequences ?? [], this.config.sequenceNumber);
      const mappingId = sequence ? sequenceMappingIdOf(sequence) : undefined;
      if (!sequence || mappingId === undefined) {
        result.skipped.push(
          `campaign #${shell.campaignId} has no sequence for held batch`,
        );
        continue;
      }

      const emails = batch.map((b) => b.email);
      const testName =
        `${HELD_TEST_NAME_PREFIX} ${emails.length} mailbox(es)`.slice(0, 120);
      const payload = {
        test_name: testName,
        description: [
          `Held/pulled mailbox recovery test (D39)`,
          `Senders are OFF live campaigns — this test does not re-attach them.`,
          `Sequence shell campaign: ${shell.campaignId}`,
          `Subject: ${sequenceSubjectPreview(sequence)}`,
          `Emails: ${emails.join(", ")}`,
        ].join("\n"),
        spam_filters: ["spam_assassin"],
        link_checker: true,
        campaign_id: shell.campaignId,
        sequence_mapping_id: mappingId,
        sender_accounts: emails,
        all_email_sent_without_time_gap: false,
        min_time_btwn_emails: 5,
        min_time_unit: "minutes" as const,
        is_warmup: false,
        ...(providerIds.length ? { provider_ids: providerIds } : {}),
      };

      if (dryRun) {
        result.created.push(`dry-run:${emails[0]}`);
        continue;
      }

      try {
        const scheduledAt = paddedScheduleDate();
        const created = await this.smartDelivery.createAutomatedPlacement({
          ...payload,
          every_days: this.config.placementTestEveryDays,
          schedule_start_time: scheduledAt.toISOString(),
          scheduler_cron_value: schedulerCronValue(
            this.config.placementTestEveryDays,
            scheduledAt,
          ),
          test_end_date: addDaysIsoLocal(
            new Date(),
            this.config.placementTestEndDays > 0
              ? this.config.placementTestEndDays
              : OPEN_ENDED_TEST_DAYS,
          ),
          provider_ids: providerIds,
        });
        const id = String(created.id);
        this.state.markHeldPlacementTest({
          testId: id,
          emails,
          campaignId: shell.campaignId,
          createdAt: new Date().toISOString(),
        });
        result.created.push(id);
        console.log(
          `[held-tests] Created recovery test ${id} for ${emails.length} held mailbox(es) (shell campaign #${shell.campaignId})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`create held test: ${message}`);
      }
      await sleep(500);
    }

    console.log(
      `[held-tests] held=${result.heldMailboxes} created=${result.created.length} stopped=${result.stopped.length} kept=${result.kept} errors=${result.errors.length}`,
    );
    await this.state.save();
    return result;
  }

  /**
   * D41 — same pattern as held-recovery tests, for off-week client inboxes.
   * They stay off live campaigns; the test uses a campaign only as a shell.
   */
  async runResting(
    opts: { dryRun?: boolean } = {},
  ): Promise<HeldPlacementTestResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: HeldPlacementTestResult = {
      dryRun,
      heldMailboxes: 0,
      created: [],
      stopped: [],
      kept: 0,
      skipped: [],
      errors: [],
      quotaBlocked: false,
    };

    if (!this.config.enableRestPlacementTests) {
      console.log(
        "[rest-tests] Disabled (ENABLE_REST_PLACEMENT_TESTS=false)",
      );
      return result;
    }

    const resting = this.state.listRestingInboxes();
    result.heldMailboxes = resting.length;
    const restEmails = new Set(resting.map((h) => h.email.toLowerCase()));

    for (const row of this.state.listRestPlacementTests()) {
      const still = row.emails.some((e) => restEmails.has(e.toLowerCase()));
      if (still) {
        result.kept += 1;
        continue;
      }
      try {
        if (!dryRun) {
          await this.smartDelivery.stopAutomatedTest(row.testId);
          this.state.clearRestPlacementTest(row.testId);
        }
        result.stopped.push(row.testId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`stop ${row.testId}: ${message}`);
      }
      await sleep(200);
    }

    if (!resting.length) {
      console.log(
        `[rest-tests] No resting mailboxes; stopped=${result.stopped.length}`,
      );
      await this.state.save();
      return result;
    }

    const covered = new Set<string>();
    for (const row of this.state.listRestPlacementTests()) {
      for (const email of row.emails) covered.add(email.toLowerCase());
    }

    const uncovered = resting.filter(
      (h) => !covered.has(h.email.toLowerCase()),
    );
    if (!uncovered.length) {
      console.log(
        `[rest-tests] All ${resting.length} resting mailbox(es) already on a recovery test`,
      );
      await this.state.save();
      return result;
    }

    const [campaigns, existingRaw] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartDelivery.listTests({}).catch(() => []),
    ]);
    const existing = normalizeTestList(existingRaw);
    const used = existing.filter(
      (t) => isAutomatedTest(t) && isTestStoppable(t),
    ).length;
    const remaining = Math.max(0, this.config.totalTestQuota - used);

    const batches = chunkArray(uncovered, this.config.maxMailboxesPerTest);
    if (batches.length > remaining) {
      result.quotaBlocked = true;
      result.skipped.push(
        `quota: need ${batches.length} rest-recovery test(s), only ${remaining} slot(s) left`,
      );
      await this.slack
        .notifyQuotaBlocked({
          used,
          quota: this.config.totalTestQuota,
          needed: batches.length,
          campaigns: [
            {
              id: 0,
              name: "Rest recovery (off-week)",
              testsNeeded: batches.length,
            },
          ],
        })
        .catch(() => undefined);
      await this.state.save();
      return result;
    }

    const providerIds = this.config.providerIds;

    for (const batch of batches) {
      const shell = await this.pickShellCampaign(batch, campaigns);
      if (!shell) {
        result.skipped.push(
          `no sequence shell for ${batch.map((b) => b.email).join(",")}`,
        );
        continue;
      }

      const sequences = await this.smartlead
        .getCampaignSequences(shell.campaignId)
        .catch(() => []);
      const sequence = pickSequence(sequences ?? [], this.config.sequenceNumber);
      const mappingId = sequence ? sequenceMappingIdOf(sequence) : undefined;
      if (!sequence || mappingId === undefined) {
        result.skipped.push(
          `campaign #${shell.campaignId} has no sequence for rest batch`,
        );
        continue;
      }

      const emails = batch.map((b) => b.email);
      const testName =
        `${REST_TEST_NAME_PREFIX} ${emails.length} mailbox(es)`.slice(0, 120);
      const payload = {
        test_name: testName,
        description: [
          `Off-week client inbox rest test (D41)`,
          `Senders are OFF live campaigns — this test does not re-attach them.`,
          `Sequence shell campaign: ${shell.campaignId}`,
          `Subject: ${sequenceSubjectPreview(sequence)}`,
          `Emails: ${emails.join(", ")}`,
        ].join("\n"),
        spam_filters: ["spam_assassin"],
        link_checker: true,
        campaign_id: shell.campaignId,
        sequence_mapping_id: mappingId,
        sender_accounts: emails,
        all_email_sent_without_time_gap: false,
        min_time_btwn_emails: 5,
        min_time_unit: "minutes" as const,
        is_warmup: false,
        ...(providerIds.length ? { provider_ids: providerIds } : {}),
      };

      if (dryRun) {
        result.created.push(`dry-run:${emails[0]}`);
        continue;
      }

      try {
        const scheduledAt = paddedScheduleDate();
        const created = await this.smartDelivery.createAutomatedPlacement({
          ...payload,
          every_days: this.config.placementTestEveryDays,
          schedule_start_time: scheduledAt.toISOString(),
          scheduler_cron_value: schedulerCronValue(
            this.config.placementTestEveryDays,
            scheduledAt,
          ),
          test_end_date: addDaysIsoLocal(
            new Date(),
            this.config.placementTestEndDays > 0
              ? this.config.placementTestEndDays
              : OPEN_ENDED_TEST_DAYS,
          ),
          provider_ids: providerIds,
        });
        const id = String(created.id);
        this.state.markRestPlacementTest({
          testId: id,
          emails,
          campaignId: shell.campaignId,
          createdAt: new Date().toISOString(),
        });
        result.created.push(id);
        console.log(
          `[rest-tests] Created rest test ${id} for ${emails.length} mailbox(es) (shell campaign #${shell.campaignId})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`create rest test: ${message}`);
      }
      await sleep(500);
    }

    console.log(
      `[rest-tests] resting=${result.heldMailboxes} created=${result.created.length} stopped=${result.stopped.length} kept=${result.kept} errors=${result.errors.length}`,
    );
    await this.state.save();
    return result;
  }

  /**
   * Prefer a campaign the mailbox was pulled from (sequence already matches
   * the offer they were sending). Fall back to any ACTIVE campaign.
   */
  private async pickShellCampaign(
    batch: Array<{ email: string; removedFromCampaigns?: number[] }>,
    campaigns: SmartleadCampaign[],
  ): Promise<{ campaignId: number } | null> {
    const byId = new Map(campaigns.map((c) => [c.id, c]));
    for (const row of batch) {
      for (const id of row.removedFromCampaigns ?? []) {
        const campaign = byId.get(id);
        if (!campaign) continue;
        return { campaignId: id };
      }
    }
    const active = campaigns.find(
      (c) => String(c.status ?? "").toUpperCase() === "ACTIVE",
    );
    return active ? { campaignId: active.id } : null;
  }
}

/** True when a SmartDelivery test is one of our held-recovery schedules. */
export function isHeldRecoveryTestName(name: string | undefined): boolean {
  return String(name ?? "").startsWith(HELD_TEST_NAME_PREFIX);
}

/** True when a SmartDelivery test is one of our off-week rest schedules. */
export function isRestRecoveryTestName(name: string | undefined): boolean {
  return String(name ?? "").startsWith(REST_TEST_NAME_PREFIX);
}
