import {
  AUTO_PLACEMENT_TEST_PREFIX,
  CANARY_COPY_TEST_PREFIX,
} from "../canon/constants.js";

export function isCanaryCopyTestName(name: string | undefined): boolean {
  return String(name ?? "").startsWith(CANARY_COPY_TEST_PREFIX);
}

export function canaryCopyTestName(campaignId: number, campaignName?: string): string {
  const label = campaignName?.trim() ? ` ${campaignName.trim()}` : "";
  return `${CANARY_COPY_TEST_PREFIX} #${campaignId}${label}`.slice(0, 120);
}

export function campaignIdFromCanaryTestName(name: string | undefined): number | undefined {
  const match = String(name ?? "").match(
    new RegExp(`^${CANARY_COPY_TEST_PREFIX}\\s+#(\\d+)`),
  );
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : undefined;
}

/**
 * A8 — Smartlead's live placement list has no campaign_id. Match
 * `Auto: <campaign name>` plus optional ` (i/n)` batch suffix.
 */
export function isAutoPlacementTestName(name: string | undefined): boolean {
  return String(name ?? "").startsWith(AUTO_PLACEMENT_TEST_PREFIX);
}

export function autoPlacementTestName(campaignName: string, batch?: string): string {
  const suffix = batch ? ` ${batch}` : "";
  return `${AUTO_PLACEMENT_TEST_PREFIX} ${campaignName}${suffix}`.slice(0, 120);
}

export function matchesAutoPlacementName(
  testName: string | undefined,
  campaignName: string,
): boolean {
  const raw = String(testName ?? "").trim();
  const want = `${AUTO_PLACEMENT_TEST_PREFIX} ${campaignName}`.trim();
  if (raw === want) return true;
  return new RegExp(
    `^${escapeRe(want)}(?: \\(\\d+\\/\\d+\\))?$`,
  ).test(raw);
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
