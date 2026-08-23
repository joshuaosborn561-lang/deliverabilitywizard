/**
 * High-level brief for Claude (or any agent) when it sets up a new
 * Smartlead campaign. Also injected into the Ops Cursor assistant.
 */

export function campaignSetupPrompt(): string {
  return [
    "Campaign setup rules (D43) — follow these when creating or staffing a campaign:",
    "",
    "1. Staffing floor is 50 *staffable* senders (connected SMTP/IMAP, not held, not resting). Generics fill the gap. Keep at least ~30% Google and ~30% Microsoft. Do not buy a third client-domain set.",
    "2. Split that client's inboxes into A and B (even split). 2 weeks on / 2 weeks off. Off-week half comes OFF live campaigns (warmup stays on). Do not leave resters on a campaign at MESSAGE_PER_DAY=0.",
    "3. Same-client fan-out still applies for *on-week* client inboxes only. A resting mailbox must not be added to every ACTIVE campaign for that client.",
    "4. Generics do not sit on the same A/B fortnight. They rest after ~14 days of live send, then become supply again after the same sit. Staggered — do not drop half the spare tire the morning clients sit.",
    "5. 21 days from InboxKit import is the warmed-vs-unwarmed clock. Pool supply for the 50 floor is warmed only. Each ACTIVE campaign also keeps ~3 purposely unwarmed pool generics sending the campaign sequence so isolation can tell copy from inboxes. Pre-warmed fleets skip that wait.",
    "6. Every mailbox: 30 campaign emails/day (warmups not included), 10-minute gap, warmup ON, plain Name / Brand signature.",
    "7. Placement tests are one recurring SmartDelivery schedule per campaign (every_days: 1), not a new test each morning. No plan quota (unlimited). Still ≤50 senders per test (SmartDelivery API limit). Launch bar is 85% same-ESP (promo tab = miss). 80% / bounce 5% are readings only — they do not pull. The only automatic live pull is Josh killing a mailbox / retiring a domain; health backfills.",
    "8. Never auto-resume a campaign someone paused or stopped by hand (do not auto-START). Protective pauses we took stay in pendingResumes only.",
    "9. Do not spend, purge, or bypass warmup/holds from chat. Approvals stay on.",
    "10. After launch: first health rebuilds unproven HOLDs once (keep only same-ESP fails below 80%), then rests clients, sits spent generics, tops up to 50, and fans out. Watch Slack on / off / generic-spare piles and [rest-baseline] / [client-rest] / [generic-rest] / [health] logs.",
    "11. Isolation: standing per-pod inbox tests answer inboxes-vs-copy. A campaign in spam is a flag, not a domain death sentence. A confirmed suppressed word is a lint *warning* before launch, not a block. The wizard never edits the live sequence until Josh or Cayden tap Switch the word. Retiring a domain or buying replacements waits for Josh. Isolation-domain mailboxes never attach to a campaign. Tests are unlimited — do not hold a copy teardown for seed approval.",
  ].join("\n");
}
