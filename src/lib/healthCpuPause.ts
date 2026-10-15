/**
 * D272 — campaign-audit (and other monitor CPU walks) can already be in
 * flight when the 15-minute health cron starts. D270 only skips a *new*
 * monitor tick; it does not pause a sitting that reached campaign-audit.
 * Production 2026-10-15 froze while health:inventory overlapped
 * monitor:campaign-audit. This is a hunch, not the whole fix: pause
 * campaign-audit CPU while health is live so the two walks do not pin
 * the loop together. Health itself must never wait on this (deadlock).
 */

export const HEALTH_CPU_PAUSE_MS = 25;

export async function pauseWhileHealthLive(
  isLive: (() => boolean) | undefined,
  opts: { label?: string } = {},
): Promise<void> {
  if (!isLive || !isLive()) return;
  const label = opts.label ?? "campaign-audit";
  console.log(
    `[${label}] health pass live — pausing CPU until health ends (D272)`,
  );
  while (isLive()) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, HEALTH_CPU_PAUSE_MS);
    });
  }
}
