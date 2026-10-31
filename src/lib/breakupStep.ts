/**
 * D306 — breakup-step CHECK ONLY.
 *
 * Step 3 is the breakup email. It must exist (`seq_number === 3`) and
 * its `seq_delay_details.delay_in_days` must be 2 so it lands on day 4
 * (step 1 on day 0, step 2 waits 2 days). Campaign-check flags
 * `missing_breakup_step` and pages Slack once per campaign per incident.
 * This module never writes sequences. D306 supersedes D186's
 * "don't touch step 3+" for check purposes only.
 *
 * Skips the same shells as D186 (`campaignHasStep2DelayRule`), plus
 * CALLER FOLLOW-UP (`Gabe Calls |` / D242) and 1-step test campaigns.
 */

import { isCallerFollowUpCampaign } from "./callerFollowUp.js";
import {
  campaignHasStep2DelayRule,
  sequenceDelayDays,
  sequenceStep2,
} from "./sequenceDelay.js";
import type { SmartleadSequence } from "../types/index.js";

export const STEP3_DELAY_DAYS = 2;

export function sequenceStep3<T extends { seq_number?: number | string | null }>(
  sequences: T[] | null | undefined,
): T | undefined {
  return sequences?.find((row) => Number(row.seq_number) === 3);
}

export function isOneStepCampaign(
  sequences: Array<{ seq_number?: number | string | null }> | null | undefined,
): boolean {
  if (!sequences?.length) return true;
  return sequenceStep2(sequences) == null;
}

export function campaignHasBreakupStepRule(campaign: {
  id?: number | null;
  name?: string | null;
}): boolean {
  if (!campaignHasStep2DelayRule(campaign)) return false;
  if (isCallerFollowUpCampaign(campaign)) return false;
  return true;
}

export function breakupStepNeedsCheck(
  sequences: Array<{
    seq_number?: number | string | null;
    seq_delay_details?: {
      delayInDays?: number | string | null;
      delay_in_days?: number | string | null;
    } | null;
  }> | null | undefined,
): boolean {
  if (isOneStepCampaign(sequences)) return false;
  const step3 = sequenceStep3(sequences);
  if (!step3) return true;
  return sequenceDelayDays(step3) !== STEP3_DELAY_DAYS;
}

export function formatBreakupStepFinding(
  sequences: SmartleadSequence[] | null | undefined,
): string | null {
  if (isOneStepCampaign(sequences)) return null;
  const step3 = sequenceStep3(sequences);
  if (!step3) return "step 3 missing (want delay 2d so it lands on day 4)";
  const days = sequenceDelayDays(step3);
  if (days === STEP3_DELAY_DAYS) return null;
  return `step 3 delay ${days == null ? "unset" : `${days}d`} (want ${STEP3_DELAY_DAYS} so it lands on day 4)`;
}
