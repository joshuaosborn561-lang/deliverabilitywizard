/**
 * D80/D88 — Smartlead's own bounce autopause stays OFF. The retired 20/7
 * band helpers were deleted (D129); the D90 trips live in
 * campaignBouncePause.ts.
 *
 * 2026-08-31 — "off" means CLEARED (`bounce_autopause_threshold: null`),
 * per Smartlead's own API contract. The old convention of writing 100 left
 * the feature enabled at a nominal threshold, and it still paused four
 * Parlay campaigns bouncing 36% two hours after a "100" write returned ok.
 * The converge in services/campaignBounceAutostop.ts writes null.
 */
