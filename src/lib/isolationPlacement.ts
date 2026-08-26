import type { ControlTemplate } from "./controlTemplate.js";
import type {
  CreateAutomatedPlacementInput,
  CreateManualPlacementInput,
  PlacementSequence,
  SchedulerCronValue,
} from "../clients/smartdelivery.js";

export function controlSequence(
  template: ControlTemplate,
  campaignName: string,
): PlacementSequence {
  return {
    campaign_name: campaignName,
    steps: [
      {
        seq_number: 1,
        seq_delay_details: { delayInDays: 0 },
        variant: true,
        variant_label: "A",
        subject: template.subject,
        email_body: template.bodyHtml,
      },
    ],
  };
}

export function copySequence(
  campaignName: string,
  subject: string,
  bodyHtml: string,
): PlacementSequence {
  return {
    campaign_name: campaignName,
    steps: [
      {
        seq_number: 1,
        seq_delay_details: { delayInDays: 0 },
        variant: true,
        variant_label: "A",
        subject,
        email_body: bodyHtml,
      },
    ],
  };
}

export function isolationManualPayload(input: {
  testName: string;
  description: string;
  senderAccounts: string[];
  sequence: PlacementSequence;
  folderId?: string | number;
  providerIds: number[];
  campaignId?: number;
  sequenceMappingId?: number;
  linkChecker?: boolean;
}): CreateManualPlacementInput {
  return {
    test_name: input.testName,
    description: input.description,
    spam_filters: ["spam_assassin"],
    link_checker: input.linkChecker ?? false,
    sender_accounts: input.senderAccounts,
    all_email_sent_without_time_gap: false,
    min_time_btwn_emails: 5,
    min_time_unit: "minutes",
    is_warmup: false,
    ...(input.campaignId ? { campaign_id: input.campaignId } : {}),
    // D112 — /spam-test/schedule rejects `sequence` when campaign_id +
    // sequence_mapping_id are set (live canary attach 2026-08-26).
    // Custom-body tests (isolation variants, no mapping) still send it.
    ...(input.sequenceMappingId != null
      ? { sequence_mapping_id: input.sequenceMappingId }
      : { sequence: input.sequence }),
    ...(input.folderId !== undefined ? { folder_id: input.folderId } : {}),
    ...(input.providerIds.length ? { provider_ids: input.providerIds } : {}),
  };
}

export function isolationSchedulePayload(
  manual: CreateManualPlacementInput,
  everyDays: number,
  scheduledAt: Date,
  cron: SchedulerCronValue,
  testEndDate: string,
  providerIds: number[],
): CreateAutomatedPlacementInput {
  return {
    ...manual,
    every_days: everyDays,
    schedule_start_time: scheduledAt.toISOString(),
    scheduler_cron_value: cron,
    test_end_date: testEndDate,
    provider_ids: providerIds,
  };
}
