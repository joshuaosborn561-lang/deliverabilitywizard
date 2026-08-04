import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  extractSenderEmails,
  pickSequence,
  sequenceMappingIdOf,
  sequenceSubjectPreview,
} from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import { chunkArray, sleep, uniqueStrings } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import type { CampaignTestPlan, SmartleadCampaign } from "../types/index.js";

export interface ScanResult {
  scanned: number;
  eligible: number;
  created: number;
  skipped: number;
  errors: string[];
  quotaBlocked: boolean;
  plans: CampaignTestPlan[];
  createdTestIds: string[];
}

/** ISO 8601 timestamp N days from base. */
export function addDaysIso(base: Date, days: number): string {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * SmartDelivery requires `schedule_start_time` to be at/after its own clock
 * at validation time. A timestamp equal to the moment this process generates
 * it is already in the past by the time the request reaches their server, so
 * every recurring test creation was rejected with "Schedule start time must
 * be greater than or equal to the current date and time." Padding a few
 * minutes forward absorbs network latency and clock skew between hosts.
 */
export function scheduleStartTime(bufferMinutes = 2, now = new Date()): string {
  return new Date(now.getTime() + bufferMinutes * 60_000).toISOString();
}

/**
 * SmartDelivery requires `test_end_date` on every /spam-test/schedule call —
 * there is no way to omit it for a truly open-ended recurring test. D8 in
 * DECISIONS.md still holds: the test itself runs indefinitely in practice,
 * because the reconciler (not this date) stops it once the campaign leaves
 * its active statuses. This far-future date only exists to satisfy the
 * required field without ever being the thing that actually ends the test.
 */
export const OPEN_ENDED_TEST_DAYS = 365 * 5;

export class CampaignScanner {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(options: { trigger: "cron" | "manual" } = { trigger: "cron" }): Promise<ScanResult> {
    const result: ScanResult = {
      scanned: 0,
      eligible: 0,
      created: 0,
      skipped: 0,
      errors: [],
      quotaBlocked: false,
      plans: [],
      createdTestIds: [],
    };

    console.log(`[scan] Starting (${options.trigger})`);

    try {
      await this.smartDelivery.assertAccessActive();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      await this.slack.send(`:x: *SmartDelivery access check failed*\n${message}`);
      await this.finish(result);
      return result;
    }

    let campaigns: SmartleadCampaign[] = [];
    try {
      campaigns = await this.smartlead.listCampaigns();
      if (!Array.isArray(campaigns)) {
        throw new Error("Unexpected campaigns response (not an array)");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to list campaigns: ${message}`);
      await this.slack.send(`:x: *Campaign scan failed*\n${message}`);
      await this.finish(result);
      return result;
    }

    result.scanned = campaigns.length;
    const statusSet = new Set(this.config.campaignStatuses);

    const existingTestsRaw = await this.smartDelivery.listTests({}).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to list existing tests: ${message}`);
      return [] as unknown;
    });
    const existingTests = normalizeTestList(existingTestsRaw);
    const testedCampaignIds = new Set<string>();
    for (const test of existingTests) {
      const cid = campaignIdOf(test);
      if (cid) testedCampaignIds.add(cid);
    }
    for (const id of Object.keys(this.state.get().testedCampaigns)) {
      testedCampaignIds.add(id);
    }

    const lastScanAt = this.state.get().lastScanAt
      ? Date.parse(this.state.get().lastScanAt!)
      : null;

    // A recurring test bills on every run, so only start one for a campaign
    // that is actually live — not merely eligible (e.g. PAUSED).
    const creationStatusSet = this.config.autoPlacementTests
      ? new Set(this.config.autoTestActiveStatuses)
      : statusSet;

    const candidates = campaigns.filter((campaign) => {
      if (!creationStatusSet.has(String(campaign.status ?? "").toUpperCase())) {
        return false;
      }
      if (testedCampaignIds.has(String(campaign.id))) {
        return false;
      }
      // Prefer campaigns created/updated since last scan; on first run include all untested.
      if (lastScanAt && Number.isFinite(lastScanAt)) {
        const created = campaign.created_at ? Date.parse(campaign.created_at) : NaN;
        const updated = campaign.updated_at ? Date.parse(campaign.updated_at) : NaN;
        const newest = Math.max(
          Number.isFinite(created) ? created : 0,
          Number.isFinite(updated) ? updated : 0,
        );
        if (newest > 0 && newest < lastScanAt) {
          // Still include if never tested — "haven't already had a placement test"
          // already handled above via testedCampaignIds.
        }
      }
      return true;
    });

    const plans: CampaignTestPlan[] = [];
    for (const campaign of candidates) {
      try {
        const plan = await this.buildPlan(campaign);
        if (!plan) {
          result.skipped += 1;
          continue;
        }
        plans.push(plan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`Campaign ${campaign.id}: ${message}`);
        result.skipped += 1;
      }
    }

    result.plans = plans;
    result.eligible = plans.length;

    if (!plans.length) {
      console.log("[scan] No eligible campaigns");
      await this.finish(result);
      if (options.trigger === "manual") {
        await this.slack.notifyRunSummary(result);
      }
      return result;
    }

    const testsNeeded = plans.reduce((sum, plan) => sum + plan.batches.length, 0);
    const used = existingTests.length;
    const remaining = Math.max(0, this.config.totalTestQuota - used);

    console.log(
      `[scan] Quota check: used=${used} quota=${this.config.totalTestQuota} needed=${testsNeeded} remaining=${remaining}`,
    );

    if (testsNeeded > remaining) {
      result.quotaBlocked = true;
      result.skipped += plans.length;
      await this.slack.notifyQuotaBlocked({
        used,
        quota: this.config.totalTestQuota,
        needed: testsNeeded,
        campaigns: plans.map((p) => ({
          id: p.campaign.id,
          name: p.campaign.name || `Campaign ${p.campaign.id}`,
          testsNeeded: p.batches.length,
        })),
      });
      await this.finish(result);
      return result;
    }

    // Re-check status right before creating: a campaign can leave its active
    // statuses (paused, completed, deleted) in the time between the initial
    // list fetch above and reaching its turn in the creation loop below —
    // this run processes plans one at a time with a pause between each.
    let freshStatusById: Map<number, string>;
    try {
      const freshCampaigns = await this.smartlead.listCampaigns();
      freshStatusById = new Map(
        freshCampaigns.map((c) => [c.id, String(c.status ?? "").toUpperCase()]),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Pre-creation status re-check failed: ${message}`);
      freshStatusById = new Map();
    }

    const eligiblePlans = plans.filter((plan) => {
      const freshStatus = freshStatusById.get(plan.campaign.id);
      if (freshStatus === undefined) return true; // re-check failed or unknown — don't block on it
      if (creationStatusSet.has(freshStatus)) return true;
      console.log(
        `[scan] Skipping campaign ${plan.campaign.id} — status changed to ${freshStatus} since candidate selection`,
      );
      result.skipped += 1;
      return false;
    });

    let providerIds: number[] = [];
    try {
      providerIds = await this.smartDelivery.resolveProviderIds(this.config.providerIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Provider ID resolution failed: ${message}`);
      if (this.config.providerIds.length) {
        providerIds = this.config.providerIds;
      }
    }

    for (const plan of eligiblePlans) {
      const createdIds: string[] = [];
      try {
        for (let i = 0; i < plan.batches.length; i += 1) {
          const batch = plan.batches[i]!;
          const batchLabel =
            plan.batches.length > 1 ? ` (${i + 1}/${plan.batches.length})` : "";
          const recurring = this.config.autoPlacementTests;
          const payload = {
            test_name: `Auto: ${plan.campaign.name || plan.campaign.id}${batchLabel}`.slice(
              0,
              120,
            ),
            description: [
              `Auto-created by Deliverability Wizard`,
              `Campaign ID: ${plan.campaign.id}`,
              `Sequence #${plan.sequenceNumber} (mapping ${plan.sequenceMappingId})`,
              `Subject: ${plan.subjectPreview}`,
              `Senders in this test: ${batch.length}`,
              recurring
                ? `Recurring every ${this.config.placementTestEveryDays} day(s) while the campaign is active`
                : `One-off manual test`,
            ].join("\n"),
            // Explicit every time — do not rely on defaults
            spam_filters: ["spam_assassin"],
            link_checker: true,
            campaign_id: plan.campaign.id,
            sequence_mapping_id: plan.sequenceMappingId,
            sender_accounts: batch,
            all_email_sent_without_time_gap: false,
            min_time_btwn_emails: 5,
            min_time_unit: "minutes" as const,
            is_warmup: false,
            ...(providerIds.length ? { provider_ids: providerIds } : {}),
          };

          if (this.config.dryRun) {
            console.log(
              `[scan] DRY_RUN would create ${recurring ? "recurring" : "manual"} test:`,
              payload.test_name,
              batch.length,
            );
            createdIds.push(`dry-run-${plan.campaign.id}-${i + 1}`);
            result.created += 1;
            continue;
          }

          const created = recurring
            ? await this.smartDelivery.createAutomatedPlacement({
                ...payload,
                every_days: this.config.placementTestEveryDays,
                schedule_start_time: scheduleStartTime(),
                test_end_date: addDaysIso(
                  new Date(),
                  this.config.placementTestEndDays > 0
                    ? this.config.placementTestEndDays
                    : OPEN_ENDED_TEST_DAYS,
                ),
              })
            : await this.smartDelivery.createManualPlacement(payload);
          const id = String(created.id);
          createdIds.push(id);
          result.created += 1;
          result.createdTestIds.push(id);
          console.log(
            `[scan] Created ${recurring ? `recurring (every ${this.config.placementTestEveryDays}d)` : "manual"} test ${id} for campaign ${plan.campaign.id} (${batch.length} mailboxes)`,
          );
          await sleep(500);
        }

        this.state.markCampaignTested({
          campaignId: plan.campaign.id,
          campaignName: plan.campaign.name || `Campaign ${plan.campaign.id}`,
          testedAt: new Date().toISOString(),
          testIds: createdIds,
          mailboxCount: plan.senderEmails.length,
          testsCreated: createdIds.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(
          `Failed creating tests for campaign ${plan.campaign.id}: ${message}`,
        );
        result.skipped += 1;
      }
    }

    await this.finish(result);
    await this.slack.notifyRunSummary(result);
    return result;
  }

  private async buildPlan(campaign: SmartleadCampaign): Promise<CampaignTestPlan | null> {
    const [accounts, sequences] = await Promise.all([
      this.smartlead.getCampaignEmailAccounts(campaign.id),
      this.smartlead.getCampaignSequences(campaign.id),
    ]);

    const senderEmails = uniqueStrings(extractSenderEmails(accounts ?? []));
    if (!senderEmails.length) {
      console.log(`[scan] Skipping campaign ${campaign.id} — no sender mailboxes`);
      return null;
    }

    const sequence = pickSequence(sequences ?? [], this.config.sequenceNumber);
    const mappingId = sequence ? sequenceMappingIdOf(sequence) : undefined;
    if (!sequence || mappingId === undefined) {
      console.log(`[scan] Skipping campaign ${campaign.id} — no sequence / mapping id`);
      return null;
    }

    const batches = chunkArray(senderEmails, this.config.maxMailboxesPerTest);
    return {
      campaign,
      senderEmails,
      sequenceMappingId: mappingId,
      sequenceNumber: sequence.seq_number,
      subjectPreview: sequenceSubjectPreview(sequence),
      batches,
    };
  }

  private async finish(result: ScanResult): Promise<void> {
    this.state.setLastScanAt(new Date().toISOString());
    await this.state.save();
    console.log("[scan] Done", {
      scanned: result.scanned,
      eligible: result.eligible,
      created: result.created,
      skipped: result.skipped,
      quotaBlocked: result.quotaBlocked,
      errors: result.errors.length,
    });
  }
}
