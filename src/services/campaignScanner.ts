import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  pickSequence,
  sequenceMappingIdOf,
  sequenceSubjectPreview,
} from "../clients/smartlead.js";
import type { SchedulerCronValue, SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import { type EspFamily, normalizeSenderEspFamily } from "../lib/esp.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import { chunkArray, sleep } from "../lib/http.js";
import { testedCampaignCoverage } from "../lib/placementCoverage.js";
import { quotaWouldBlock, remainingTestSlots } from "../lib/testQuota.js";
import type { StateStore } from "../state/store.js";
import type {
  CampaignTestPlan,
  SmartleadCampaign,
  SmartleadEmailAccount,
} from "../types/index.js";

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

/**
 * Interleave a campaign's senders by ESP (Gmail / Outlook / other) round-robin
 * before chunking into placement-test batches, so each batch is as balanced
 * as the campaign's actual account mix allows — instead of whichever type the
 * API happened to list first dominating a whole batch. (BCP Generic's first
 * test batch on 2026-08-05 came back 47 Outlook / 3 Gmail purely from list
 * order, even though the campaign itself runs closer to 62/38 Outlook/Gmail
 * and had 28 Gmail senders available.) When one ESP has fewer accounts than
 * the other, balance is front-loaded into the earlier batches — the earliest
 * batch this produces is the most-balanced one possible, with any surplus of
 * the larger ESP spilling into later batches.
 */
export function interleaveSendersByEsp(
  accounts: Array<SmartleadEmailAccount | Record<string, unknown>>,
): string[] {
  const buckets = new Map<EspFamily, string[]>();
  const seen = new Set<string>();
  for (const account of accounts) {
    const nested =
      (account as { email_account?: SmartleadEmailAccount }).email_account ??
      account;
    const row = nested as SmartleadEmailAccount;
    const email = accountEmail(row);
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const esp = normalizeSenderEspFamily(row.type);
    const bucket = buckets.get(esp) ?? [];
    bucket.push(email);
    buckets.set(esp, bucket);
  }

  const order: EspFamily[] = ["google", "microsoft", "other"];
  const cursors = new Map<EspFamily, number>(order.map((esp) => [esp, 0]));
  const total = [...buckets.values()].reduce((n, list) => n + list.length, 0);
  const result: string[] = [];
  while (result.length < total) {
    for (const esp of order) {
      const bucket = buckets.get(esp);
      if (!bucket) continue;
      const i = cursors.get(esp)!;
      if (i < bucket.length) {
        result.push(bucket[i]!);
        cursors.set(esp, i + 1);
      }
    }
  }
  return result;
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
export function paddedScheduleDate(bufferMinutes = 2, now = new Date()): Date {
  return new Date(now.getTime() + bufferMinutes * 60_000);
}

export function scheduleStartTime(bufferMinutes = 2, now = new Date()): string {
  return paddedScheduleDate(bufferMinutes, now).toISOString();
}

/**
 * SmartDelivery also requires `scheduler_cron_value` alongside `every_days` —
 * an object describing the allowed send window, not a cron string. (An
 * earlier version of this fix sent a cron string based on a misread of
 * SmartDelivery's response examples; confirmed wrong via a live validation
 * probe — POST'ing with a string got `"scheduler_cron_value" must be of type
 * object`, an object got past it entirely.) Their request schema for this
 * field still isn't publicly documented (their own API reference only shows
 * an empty `{}` request example), so this deliberately picks the least
 * restrictive value that satisfies the schema — a full day, every day, in
 * UTC — and leaves the actual recurrence timing to `every_days` and
 * `schedule_start_time`, which are already correct. A narrower window here
 * would just be a second, harder-to-notice way for this to silently stop
 * firing.
 */
export function schedulerCronValue(
  everyDays: number,
  at: Date,
): SchedulerCronValue {
  return {
    tz: "UTC",
    days: everyDays === 7 ? [at.getUTCDay()] : [0, 1, 2, 3, 4, 5, 6],
    startHour: "00:00",
    endHour: "23:59",
  };
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
      await this.slack.send(
        `:x: *Couldn't reach placement tests*\nWill retry. If this keeps happening, Josh needs to check the Smartlead connection.\n${message}`,
      );
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
      await this.slack.send(
        `:x: *Couldn't scan campaigns for placement tests*\nWill retry.\n${message}`,
      );
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
    const listedTests = normalizeTestList(existingTestsRaw);
    // Report rows omit campaign_id — enrich active/auto tests so we do not
    // create a second recurring schedule for a campaign that already has one.
    const existingTests = await this.smartDelivery
      .enrichCampaignIds(listedTests)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to enrich test campaign ids: ${message}`);
        return listedTests;
      });
    // Only stoppable automated tests count as coverage. A completed manual
    // (or a stale state mark pointing at one) must not block a real recurring
    // test from being created.
    const testedCampaignIds = testedCampaignCoverage(
      existingTests,
      this.state.get().testedCampaigns,
    );

    const lastScanAt = this.state.get().lastScanAt
      ? Date.parse(this.state.get().lastScanAt!)
      : null;

    // A recurring test bills on every run, so only start one for a campaign
    // that is actually live — not merely eligible (e.g. PAUSED).
    const creationStatusSet = this.config.autoPlacementTests
      ? new Set(this.config.autoTestActiveStatuses)
      : statusSet;

    const candidates = campaigns.filter((campaign) => {
      if (isPodControlShellCampaign(campaign)) return false;
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
    const remaining = remainingTestSlots(this.config.totalTestQuota, used);
    const remainingLabel = Number.isFinite(remaining) ? String(remaining) : "unlimited";

    console.log(
      `[scan] Quota check: used=${used} quota=${this.config.totalTestQuota || "unlimited"} needed=${testsNeeded} remaining=${remainingLabel}`,
    );

    if (quotaWouldBlock(this.config.totalTestQuota, used, testsNeeded)) {
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

          const scheduledAt = paddedScheduleDate();
          const created = recurring
            ? await this.smartDelivery.createAutomatedPlacement({
                ...payload,
                every_days: this.config.placementTestEveryDays,
                schedule_start_time: scheduledAt.toISOString(),
                scheduler_cron_value: schedulerCronValue(
                  this.config.placementTestEveryDays,
                  scheduledAt,
                ),
                test_end_date: addDaysIso(
                  new Date(),
                  this.config.placementTestEndDays > 0
                    ? this.config.placementTestEndDays
                    : OPEN_ENDED_TEST_DAYS,
                ),
                // Confirmed required on this endpoint via a live validation
                // probe (2026-08-05) — unlike the manual endpoint, this one
                // rejects the request outright if omitted, so it can't be
                // left conditional on providerIds ever resolving non-empty.
                provider_ids: providerIds,
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
        // Same provider_ids are used for every campaign this run — further
        // creates will fail the same way. Stop and surface once.
        if (
          /no seed accounts found|seed accounts found for the provided provider/i.test(
            message,
          )
        ) {
          console.warn(
            `[scan] No SmartDelivery seed accounts for provider IDs — skipping remaining campaigns this run`,
          );
          break;
        }
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

    const senderEmails = interleaveSendersByEsp(accounts ?? []);
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
