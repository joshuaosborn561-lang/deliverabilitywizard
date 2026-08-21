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
    "5. Fresh (non-prewarmed) InboxKit mailboxes owe 21 days before live send. Pre-warmed fleets (crosslaunchco.com, crossscaleco.com, cleartechco.com) skip that wait. Pool warmup stays 14 days.",
    "6. Every mailbox: 30 campaign emails/day (warmups not included), 10-minute gap, warmup ON, plain Name / Brand signature.",
    "7. Placement tests are one recurring SmartDelivery schedule per campaign (every_days: 1), not a new test each morning. Quota is 120.",
    "8. Never auto-resume a campaign someone paused or stopped by hand (do not auto-START). Protective pauses we took stay in pendingResumes only.",
    "9. Do not spend, purge, or bypass warmup/holds from chat. Approvals stay on.",
    "10. After launch: first health rebuilds unproven HOLDs once (keep only same-ESP fails below 80%), then rests clients, sits spent generics, tops up to 50, and fans out. Watch Slack on / off / generic-spare piles and [rest-baseline] / [client-rest] / [generic-rest] / [health] logs.",
  ].join("\n");
}
