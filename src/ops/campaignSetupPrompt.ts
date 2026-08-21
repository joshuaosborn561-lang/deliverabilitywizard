/**
 * High-level brief for Claude (or any agent) when it sets up a new
 * Smartlead campaign. Also injected into the Ops Cursor assistant so
 * freeform “set up / launch a campaign” asks stay on D41 rails.
 */

export function campaignSetupPrompt(): string {
  return [
    "Campaign setup rules (D41) — follow these when creating or staffing a campaign:",
    "",
    "1. Staffing floor is 50 *staffable* senders (connected SMTP/IMAP, not held, not resting). Generics fill the gap. Do not buy a third client-domain set.",
    "2. Client inboxes rest 2 weeks on / 2 weeks off. Off-week boxes come OFF live campaigns (warmup stays on). Do not leave resters on a campaign at MESSAGE_PER_DAY=0.",
    "3. Same-client fan-out still applies for *on-week* client inboxes only. A resting mailbox must not be added to every ACTIVE campaign for that client.",
    "4. New campaigns (created_at last 7 days) are canaries: attach only ~15% of on-week client inboxes. Generics may still top up to 50. If 3+ unrelated sending domains drop on same-ESP, pause *that* campaign only — do not auto-START it.",
    "5. Fresh (non-prewarmed) InboxKit mailboxes owe 21 days before live send. Pre-warmed fleets (crosslaunchco.com, crossscaleco.com, cleartechco.com) skip that wait. Pool warmup stays 14 days.",
    "6. Every mailbox: 30 campaign emails/day (warmups not included), 10-minute gap, warmup ON, plain Name / Brand signature.",
    "7. Placement tests are one recurring SmartDelivery schedule per campaign (every_days: 1), not a new test each morning. Quota is 120.",
    "8. Never auto-resume a campaign someone paused or stopped by hand. Protective pauses we took stay in pendingResumes only.",
    "9. Do not spend, purge, or bypass warmup/holds from chat. Approvals stay on.",
    "10. After launch: health (15m) will rest, top-up, and fan-out. Watch Slack on / off / generic-spare piles and [client-rest] / [health] logs.",
  ].join("\n");
}
