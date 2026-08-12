/**
 * Whether a remediation pass may record a mailbox as benched.
 *
 * A mailbox counts as benched only once it is actually OFF its campaigns.
 * Recording a hold while a campaign removal failed seals the failure: later
 * runs skip anything already held (`getHeldInbox`) or already remediated
 * (`hasRemediation`), so the mailbox would keep sending under a HOLD-UNTIL tag
 * and never be retried.
 */
export type HoldOutcome =
  /** Off its campaigns with warmup back on — safe to tag and dedupe. */
  | "hold"
  /** A removal failed — leave unmarked so the next run retries. */
  | "retry-removal-failed"
  /** Nothing achieved at all — leave unmarked. */
  | "retry-nothing-achieved";

export function classifyHoldOutcome(opts: {
  removeFailures: number;
  warmupOk: boolean;
  removedCount: number;
  dryRun: boolean;
}): HoldOutcome {
  // A dry run performs no writes, so nothing can be half-done.
  if (opts.dryRun) return "hold";
  if (opts.removeFailures > 0) return "retry-removal-failed";
  if (!opts.warmupOk && opts.removedCount === 0) return "retry-nothing-achieved";
  return "hold";
}
