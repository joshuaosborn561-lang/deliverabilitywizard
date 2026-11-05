/**
 * RETIRED (D157) — Smartlead High Bounce Rate Auto Protection has no
 * working public-API off-switch. Every generation of this script's write
 * (`bounce_autopause_threshold` = 100 / null / banana) returned ok:true
 * and left the UI checkbox unchanged. Off-switch: untick the box on each
 * campaign's SETUP page (or ask Smartlead support for an account-wide
 * disable). Attribution: LIST GET /campaigns →
 * campaign_activity_logs.paused_reason === "bounce protection".
 */
console.error(
  "[force-autopause-off] refused — D157: bounce_autopause_threshold writes are discarded by Smartlead. Untick High Bounce Rate Auto Protection on the campaign SETUP page.",
);
process.exit(1);
