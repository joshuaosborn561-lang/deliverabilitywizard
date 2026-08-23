/** SmartDelivery test / folder names that the isolation system owns. */

export const POD_CONTROL_TEST_PREFIX = "Pod control:";
export const RIG_CONTROL_TEST_PREFIX = "Rig control:";
export const ISOLATION_TEST_PREFIX = "Isolation:";
export const CANARY_COPY_TEST_PREFIX = "Canary copy:";
export const POD_CONTROL_FOLDER_NAME = "Pod controls";
export const ISOLATION_FOLDER_NAME = "Isolation teardowns";

export function isIsolationManagedTestName(name: string | undefined): boolean {
  const value = String(name ?? "");
  return (
    value.startsWith(POD_CONTROL_TEST_PREFIX) ||
    value.startsWith(RIG_CONTROL_TEST_PREFIX) ||
    value.startsWith(ISOLATION_TEST_PREFIX)
  );
}

export function canaryCopyTestName(
  campaignId: number,
  campaignName?: string,
): string {
  const label = campaignName?.trim() ? ` ${campaignName.trim()}` : "";
  return `${CANARY_COPY_TEST_PREFIX} #${campaignId}${label}`.slice(0, 120);
}

export function campaignIdFromCanaryTestName(
  name: string | undefined,
): number | undefined {
  const match = String(name ?? "").match(
    new RegExp(`^${CANARY_COPY_TEST_PREFIX}\\s+#(\\d+)`),
  );
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : undefined;
}

export function isCanaryCopyTestName(name: string | undefined): boolean {
  return String(name ?? "").startsWith(CANARY_COPY_TEST_PREFIX);
}

export function podControlTestName(podName: string, chunk: number, chunks: number): string {
  const suffix = chunks > 1 ? ` (${chunk}/${chunks})` : "";
  return `${POD_CONTROL_TEST_PREFIX} ${podName}${suffix}`.slice(0, 120);
}

export function rigControlTestName(domain: string): string {
  return `${RIG_CONTROL_TEST_PREFIX} ${domain}`.slice(0, 120);
}

export function isolationVariantTestName(
  campaignId: number,
  kind: string,
  index: number,
): string {
  return `${ISOLATION_TEST_PREFIX} #${campaignId} ${kind} ${index + 1}`.slice(
    0,
    120,
  );
}
