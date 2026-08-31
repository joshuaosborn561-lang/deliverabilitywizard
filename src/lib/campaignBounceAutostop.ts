/**
 * D80/D88 — the retired 20/7 band helpers were deleted (D129); the D90
 * trips live in campaignBouncePause.ts.
 *
 * D157 (2026-08-31) — Smartlead's High Bounce Rate Auto Protection has no
 * working public-API control at all. POST /campaigns/{id}/settings
 * schema-validates `bounce_autopause_threshold` and then discards it (a
 * "banana" write returns ok:true; the UI keeps its value), and no GET
 * returns it. Every generation of API "off" write — 100 (D80/D124), null
 * (D155) — was a no-op; the fleet's thresholds only ever change in the UI.
 * Nothing in this repo writes that field any more. Off-switch: the
 * campaign SETUP page. Attribution: `campaign_activity_logs.paused_reason:
 * "bounce protection"` on GET /campaigns.
 */
