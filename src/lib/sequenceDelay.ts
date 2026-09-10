/**
 * D186 — every client campaign's second email waits 2 days.
 *
 * Step 1 stays 0. Step 2 must be `seq_delay_details.delay_in_days = 2`.
 * Canary / pod-control / word-hunt shells and 1-step instrumentation
 * are skipped. Step 3+ is not this decision.
 */

import { isAnyShellCampaign } from "./canaryShell.js";
import { isWordHuntShellCampaign } from "./wordHuntShell.js";
import type { SmartleadSequence } from "../types/index.js";

export const STEP1_DELAY_DAYS = 0;
export const STEP2_DELAY_DAYS = 2;

export function sequenceDelayDays(
  sequence:
    | {
        seq_delay_details?: {
          delayInDays?: number | string | null;
          delay_in_days?: number | string | null;
        } | null;
      }
    | null
    | undefined,
): number | null {
  const details = sequence?.seq_delay_details;
  if (!details) return null;
  const raw = details.delay_in_days ?? details.delayInDays;
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function sequenceStep2<T extends { seq_number?: number | string | null }>(
  sequences: T[] | null | undefined,
): T | undefined {
  return sequences?.find((row) => Number(row.seq_number) === 2);
}

export function campaignHasStep2DelayRule(campaign: {
  id?: number | null;
  name?: string | null;
}): boolean {
  if (isAnyShellCampaign(campaign)) return false;
  if (isWordHuntShellCampaign(campaign)) return false;
  return true;
}

export function step2NeedsDelayFix(
  sequences: Array<{
    seq_number?: number | string | null;
    seq_delay_details?: {
      delayInDays?: number | string | null;
      delay_in_days?: number | string | null;
    } | null;
  }> | null | undefined,
): boolean {
  const step2 = sequenceStep2(sequences);
  if (!step2) return false;
  return sequenceDelayDays(step2) !== STEP2_DELAY_DAYS;
}

export function formatStep2DelayFinding(
  sequences: SmartleadSequence[] | null | undefined,
): string | null {
  const step2 = sequenceStep2(sequences);
  if (!step2) return null;
  const days = sequenceDelayDays(step2);
  if (days === STEP2_DELAY_DAYS) return null;
  return `step 2 delay ${days == null ? "unset" : `${days}d`} (want ${STEP2_DELAY_DAYS})`;
}

export function ensureStep2Delay(sequences: SmartleadSequence[]): {
  sequences: SmartleadSequence[];
  changed: boolean;
} {
  if (!step2NeedsDelayFix(sequences)) {
    return { sequences, changed: false };
  }
  const next = sequences.map((sequence) => {
    if (Number(sequence.seq_number) !== 2) return sequence;
    return {
      ...sequence,
      seq_delay_details: {
        ...(sequence.seq_delay_details ?? {}),
        delay_in_days: STEP2_DELAY_DAYS,
        delayInDays: STEP2_DELAY_DAYS,
      },
    };
  });
  return { sequences: next, changed: true };
}
