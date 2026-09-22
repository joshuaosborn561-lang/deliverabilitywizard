/**
 * High-level brief for Claude (or any agent) when it sets up a new
 * Smartlead campaign. Also injected into the Ops Cursor assistant.
 */

export function campaignSetupPrompt(): string {
  return [
    "Campaign setup rules (D43) — follow these when creating or staffing a campaign:",
    "",
    "1. Staffing floor for a named client is max(half that client's named inboxes per POD, 40 per POD) at client inventory (40 POD-A + 40 POD-B), not 40 unique senders on a campaign (D203). Named first. Exclusive client-signed generics fill a POD up to 40 when the named half is short — do not dump the free pool past that shortfall. SalesGlider with ≥40 named per POD must not carry pool generics. Vasco is not special. Rotating-pool generics still staff a POC client (Goliath) beyond that. Keep at least ~30% Google and ~30% Microsoft on the campaign, and when the client has both ESPs keep neither Outlook nor Gmail under ~1/3 of each POD's 40 (no monoculture — D203). Do not buy a third client-domain set.",
    "2. Split that client's **named** inboxes into a **static** even A/B (ESP-balanced within Outlook and within Gmail). Never retag named seats between POD-A and POD-B to staff the on-week campaign. 2 weeks on / 2 weeks off. Off-week POD rests ready (warmup stays on). Do not leave resters on a campaign at MESSAGE_PER_DAY=0.",
    "3. Same-client fan-out still applies for *on-week* client inboxes only. A resting mailbox must not be added to every ACTIVE campaign for that client.",
    "4. Generics do not sit on the same A/B fortnight. They rest after ~14 days of live send, then become supply again after the same sit. Staggered — do not drop half the spare tire the morning clients sit.",
    "5. 21 days from InboxKit import is the warmed-vs-unwarmed clock. Pool supply is warmed only. Each sending inbox must be on a living known-good copy canary (pod-control test). Each ACTIVE campaign must have its copy on the unwarmed fleet canary (Canary copy test: 2 domains × 3 inboxes, Google + Outlook, warmup off, off the campaign). Pre-warmed fleets skip the 21-day wait.",
    "6. Mailbox daily cap: Outlook/Microsoft 15 campaign emails/day, Gmail/SMTP 30 (warmups not included, D183). 10-minute gap, warmup ON (except the unwarmed canary fleet), plain Name / Brand signature that matches the campaign client — never another client's brand.",
    "7. Placement tests are one recurring SmartDelivery schedule per campaign (every_days: 1), not a new test each morning. No plan quota (unlimited). Still ≤50 senders per test (SmartDelivery API limit). Launch bar is 85% same-ESP (promo tab = miss). 80% / bounce 5% are readings only — they do not pull. The bounce loop (D90) pauses a campaign over 10% lifetime bounce after 1,000 leads emailed, or more than 10 new bounces in 10 minutes; leave Smartlead bounce auto-pause off. The only automatic live pulls are Josh killing a mailbox / retiring a domain and the 21-day warmup gate (D105); health backfills.",
    "8. Never auto-resume a campaign someone paused or stopped by hand (do not auto-START). Protective pauses we took stay in pendingResumes only. Bounce pauses are not pendingResumes and wait for a human. A clean POC may START after signature QA, and only at or above the 85% launch bar (D106).",
    "9. Do not spend, purge, or bypass the warmup gate from chat. Approvals stay on.",
    "10. After launch: health (15m) rests clients, sits spent generics, tops up each POD to 40 at inventory (named + exclusive client-signed generics), and fans the on-week POD onto ACTIVE campaigns. Slack only pages a burned domain, an isolated word, the EOD scoreboard, a button result, or Allow generics.",
    "11. Isolation: standing per-pod inbox tests answer inboxes-vs-copy. A campaign in spam is a flag, not a domain death sentence. A confirmed suppressed word is a lint *warning* before launch, not a block. The wizard never edits the live sequence until Josh or Cayden tap Make the changes. Retiring a burned domain or buying cover replacements waits for Cayden (or Josh). Buying the canary fleet waits for Josh. Isolation-domain mailboxes never attach to a campaign. Tests are unlimited — do not hold a copy teardown for seed approval.",
  ].join("\n");
}
