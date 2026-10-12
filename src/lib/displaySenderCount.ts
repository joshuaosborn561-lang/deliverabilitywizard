/**
 * D259 — Slack / human-facing sender counts are whole senders.
 * Internal staffing math stays fractional (Azure / Entra seats weigh 0.1).
 *
 * 1. Scrub IEEE float noise by rounding to 1e-6 first.
 * 2. Shortfall / short / need: Math.ceil — never understate what is missing.
 * 3. Assigned / staffable / named / sending: Math.floor — never overstate
 *    what is already on.
 */

export const DISPLAY_SENDER_FLOAT_EPS = 1e-6;

export function scrubSenderFloat(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / DISPLAY_SENDER_FLOAT_EPS) * DISPLAY_SENDER_FLOAT_EPS;
}

/** Shortfall, short, need — round up after the 1e-6 scrub. */
export function displayShortfallSenders(value: number): number {
  return Math.max(0, Math.ceil(scrubSenderFloat(value)));
}

/** Assigned, staffable, named, sending — round down after the 1e-6 scrub. */
export function displayStaffedSenders(value: number): number {
  return Math.max(0, Math.floor(scrubSenderFloat(value)));
}
