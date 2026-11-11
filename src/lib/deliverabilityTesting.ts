/**
 * D333 — deliverability testing is OFF (Josh, 2026-11-11).
 *
 * One switch: `DELIVERABILITY_TESTING_ENABLED`. Only the exact string
 * "true" turns testing back on; anything else (unset, "1", "TRUE", "yes")
 * leaves it off. While off, the wizard creates no SmartDelivery placement
 * tests ("Auto: campaign placement", "Pod control known-good",
 * "Canary copy"), no "Canary shell" campaigns, runs no canary-adopt and no
 * monitor-results, and never emits or counts the testing findings below.
 *
 * Read at call time (not cached) so a test file can flip it per case.
 * No imports — config.ts and the pure lib helpers both depend on this.
 */
export const DELIVERABILITY_TESTING_ENV = "DELIVERABILITY_TESTING_ENABLED";

export function isDeliverabilityTestingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[DELIVERABILITY_TESTING_ENV] === "true";
}

/**
 * Canon findings that only exist because testing exists. While testing is
 * off they are never emitted, and stored rows carrying them are dropped
 * from /health, Slack, the Today board and the wake queue.
 */
export const TESTING_FINDING_KINDS: ReadonlySet<string> = new Set([
  "no_placement_test",
  "missing_canary",
  "inbox_missing_known_good",
  // Scored from a placement reading; with no tests it is never current.
  "below_launch_bar",
]);

export function isTestingFinding(finding: string): boolean {
  return TESTING_FINDING_KINDS.has(finding.split(":")[0] ?? "");
}

/** Drop testing findings when testing is off; identity when it is on. */
export function withoutTestingFindings(
  findings: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (isDeliverabilityTestingEnabled(env)) return [...findings];
  return findings.filter((finding) => !isTestingFinding(finding));
}

/** One log line per skipped entry point, so Railway shows the gate fired. */
export function logTestingOff(where: string): void {
  console.log(
    `[testing-off] ${where} skipped — DELIVERABILITY_TESTING_ENABLED is not "true" (D333)`,
  );
}
