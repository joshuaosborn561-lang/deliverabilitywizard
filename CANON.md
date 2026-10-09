# Canon — what this system does

Canon as of **D252** (2026-10-09). One page of current truth. When a new
decision lands in `DECISIONS.md`, this file is updated **in the same PR** —
a decision that is not reflected here is not finished shipping (the meta
guard in `src/guards/meta.test.ts` enforces both).

`DECISIONS.md` is the append-only historical ledger: it records every call
and every reversal, and most of it is **superseded**. Do not derive behaviour
from it. Derive behaviour from this file; use the ledger only to understand
*why* a rule here exists (each rule cites its decision numbers).

## Mission

Client campaigns send every day, land in inboxes not spam, nothing sits
silently broken, and clients book meetings. Automation does the babysitting;
Slack speaks when CANON is out of compliance, a human decision is needed,
or the day is done. Silent findings are a bug (D163).

## Campaign classes

**CALLER FOLLOW-UP (D242).** Config-driven so more callers can be
added later: campaign ids (`CALLER_FOLLOWUP_CAMPAIGN_IDS`, default
4085158 SalesGlider / 4085159 EMCOR / 4085160 Deep Roots) **or**
name prefix `Gabe Calls |`, plus sender tag
`CALLER_FOLLOWUP_SENDER_TAG` (default `GABE-VM-RESERVED`). Today's
caller is Gabe Lopez. Leads are added one at a time by the
allo-caller-email-router when he leaves a voicemail — each email
continues his call, so it must read as him and send fast.

Bridge senders `gabriel@sorrelquotaio.co` / `goldworkio.co` /
`solacecorehq.co` (SL 24255344 / 24255318 / 24255314) sit in
SalesGlider 345263 and serve all three campaigns. That is the
one-client-per-sender exception. Every stage respects:

1. Signature stays **empty**. Never apply or converge one. The
   sign-off is hard-coded in the body (`Gabriel Lopez` + client).
2. From name stays as set. Never rename.
3. Only these boxes on these campaigns. Never attach any other
   mailbox. The `GABE-VM-RESERVED` tag does **not** let a seat
   skip the own-campaign or 21-day rules (D244 — 10/6–10/7 the
   tag-first attach helper restaffed unwarmed Mesa / Deep Roots
   / unlisted reserved seats onto ACTIVE SalesGlider 4085158).
   Only the three gabriel@ bridge seats may sit on all three
   campaigns. Owned `gabe@` attach only to that client's Gabe
   Calls campaign after 21 warm days. Other reserved-tagged
   seats (new domains not in the owned list) never attach.
   Never fan class boxes out or use them as top-up / generic /
   POC supply. min40 **and fan-out staffing** skip the class,
   including Deep Roots 4085160 POC fill — class attach is a
   dedicated path, not named-client top-up. Reserved seats
   never receive POD-A/POD-B; pod-tags strips any that landed.
4. Exempt from the A/B POD rest cycle and the generic send clock.
   They send every weekday.
5. Exempt from the half-client staffing floor and the 30/30 ESP
   mix check.
6. Schedule Mon–Fri 07:00–20:00 America/Chicago,
   `min_time_btw_emails` 3. Never converge back to Mon–Thu or the
   10-minute canon values.
7. Exempt from runway and top-up alerts.
8. Prewarmed (`WARMUP-GATE-EXEMPT`). Warmup stays on. Placement,
   bounce, and blacklist still monitor; if one needs to be killed
   or unlinked, page Slack (Josh) first — do not act.
9. Twelve owned `gabe@` boxes (SalesGlider: gosalesglider.info,
   trysalesglider.info, salesglidersdr.info, salesglidermrr.info;
   EMCOR/Mesa: trymesaco.info, trymesahq.info, getmesaco.info,
   getmesahq.info; Deep Roots: brightlanehq.info,
   clearharborco.info, northpeakteam.info, steadfieldhq.info)
   stay regular through the 21-day warmup. When they clear, attach
   each client's four to that client's Gabe Calls campaign only,
   under rules 1–8. Bridge gabriel@ seats come off by 2026-11-03
   (page Josh; do not unlink).
10. Never START or PAUSE these campaigns from automation.
    **Exception (Josh, 2026-10-06):** the allo-caller-email-router
    may START a CALLER FOLLOW-UP campaign only when it is
    COMPLETED, right after it adds a lead (Smartlead flips an
    empty campaign to COMPLETED). Never on PAUSED, DRAFTED,
    STOPPED, or any other status. The wizard still never STARTs
    or PAUSEs these campaigns.

Leave `message_per_day` alone on class senders (no reset to 30).
Caps ramp manually (35 on Oct 12).

## The machine

| Loop | Cadence | Owns |
|---|---|---|
| Canon sweep (health) | 15 min | ONE Smartlead inventory fetch shared by every stage (D84), published to the machine-wide account book — a read that shrinks 20%+ needs two consecutive reads to be believed, and a failed read serves the last accepted book (D132). Reconnect disconnected SMTP/IMAP (D94) → client A/B rest (D43; ESP-balanced A/B within Outlook and within Gmail — D192; no separate generic send-clock — D221; on-week restore refuses under-warmed — D154; Insight campaigns rest like any named client (D189 rest-sticky retired by D229); ACTIVE detach will not drop *on-week staffable* below 40 per campaign — D197/D198/D199/D203/D207/D209; off-week named unlink even at 40 total linked — D228; dedicated named-client generics including client-sig are not foreign Goliath — D198/D199; same-client generics may multi-link like named seats — D207/D209; a rest record on a still-attached seat is not a peel exemption — D209; named-client inventory is 40/40 (each POD independently, including the off-week cylinder) via named + fleet-pool generic top-up only while that POD needs them — D203/D221/D228) → 21-day warmup gate pull (D105) → fan-out / top-up / one-client cleanup (D26, D75/D76, D84, D99, D197, D198, D199, D200, D203) → mailbox gap + volume + canary-warmup-off converge (D35, D83) → foreign-signature rewrite (D74; Insight 582890 is not SalesGlider 345263 — D192; D184 exclusive-blank staff is retired) → campaign first-check leftovers incl. signature auto-write (D92; Insight-in-copy writes Josh Osborn / Insight into the body, never `%signature%` — D178; Insight client mailbox sig is `Josh Osborn` / `Insight` — D31/D192) and **step-2 delay auto-write** (`step2_delay` → 2 days, D186) → **merge-tag fill QA** on first-check and when the lead list grew (D180; `merge_tag_blank` — pages Slack; never rewrites live copy or lead fields) → scan-backfill when a placement test is missing (D116) → canary-copy attach (heals emails-without-testId so the unwarmed reading can finish) → **isolation on-ramp** (score canary/live same-ESP → `markCopySuspect` → evaluate; live % never rotates) every pass so ugly inbox is remediating within one cycle (D158/D159) — a latest INCONCLUSIVE (or `evaluatedAt` with no covering COPY/INFRA/HEALTHY run) **re-queues on ACTIVE senders only** (D164/D165) and the branch loop **re-reads** existing suspects including PAUSED lives already on the list (D164; placement *new* queue stays ACTIVE-only) → stage watchdog + `canonCompliant` yes/no (D108) — an overdue stage **pages Slack once per episode** with a recovery note when it comes back (D149). Same-ESP under 80%, isolation queued, and COPY / INFRA / INCONCLUSIVE **page Slack once per campaign per incident** (`ops_alert`, D163). `/health` names canaries/campaigns still under 80% with no open isolation run or suspect, plus `isolation-branch` lastOk, plus overdue stages (`overdueStages` / per-stage `overdue`, D166). `pod-cover` ticks every pass — idle records lastOkAt with a skip reason; SmartDelivery grow still only when `inbox_missing_known_good` exists, throttled hourly (D89/D166). Old-client teardown (D107/D111) retired (D144). |
| Bounce loop | 10 min | **Never pauses, never STARTs** (D40/D148 — Josh: "i dont want anything paused anymore... investigating remediating and readding"). A REAL burst — >10 new bounces inside the 10-minute window whose sampled bounced sends are under 24h old (D141); a tripped counter samples the bounced rows first (retrying while the analytics ledger lags), a ledger dump of stale bounces logs loudly and does nothing, unreadable rows defer to the next tick — classifies the sampled SMTP reasons (tenant-rate-limit / tenant-outbound-block / sender-blocked / invalid-recipient / content-block, D140/D213), Slacks ONE receipt naming the burst, the verdict and the plan, opens a **resurrection incident** when the verdict blames the sender, and a **dominant content_block also queues isolation** (D158 — same copy-suspect flag as an ugly canary; never a pause); a re-trip inside the hour folds into the open incident silently. The D90 lifetime-rate rule stays retired. Smartlead's own High Bounce Rate Auto Protection is **UI-only** (D157): the public API validates `bounce_autopause_threshold` and then discards it (a "banana" write returns ok; no GET returns it), so no code here writes or reads the field — the D80/D124/D155 converge generations were no-ops and are deleted. It is unticked on the campaign SETUP page at build (the build skill's QA gate) and by hand for existing campaigns; a Smartlead-initiated pause is recognized by `campaign_activity_logs.paused_reason: "bounce protection"` on GET /campaigns. Never touches COMPLETED/STOPPED. Routing: a Microsoft tenant hitting its daily cap (550 5.7.233) is the D219 24h hold + same-client substitute (weekday EOD digest, never a per-bounce page; D140 still classifies the verdict); a `550 5.1.8` / AS(42004) outbound-spam block — ANY sample, never dominant-gated (D145), never burst-gated, ACTIVE or PAUSED (D162) — opens the standard **burned-domain retire ask** for that sender's domain, receipts + buttons, one pending ask per domain (D146), **unless that domain is already retired** (executed `retire_domain` or history `status=retired`, any age — D179; the old 7-day window re-prompted `boldercyperpartnerhub.info` on 2026-09-09), **and writes that domain (and sender account id) onto the attach blocklist** so restaff cannot put it back (D176); a Smartlead bounce-protection pause must not hide it; a bad-list verdict re-queues nothing and points at the list. **The remediation itself releases the resend** (D147/D148): the incident scans its window (each lead's own NDR re-read; bad addresses stay dead; once per lead per campaign; 20 lead-reads per tick) and parks sender-fault leads until their gate opens — tenant_rate_limit: the next UTC day after the bounced send (cap reset); sender_blocked: the domain's retire ask resolved; content_block: the sequence edited after the incident. Suppression lists respected on the re-add; a gate shut 7 days expires its leads with a receipt; one receipt per flushed wave. Pre-D148 pause stamps still drain: a human START of one opens its job (D147), then the stamp clears — no new stamps are ever written. |
| Campaign check | Hourly (yields to a running health pass, D122) | Re-inspect blocked first-checks; sweep pod/shell posture, signatures, client tag, one-client, canary coverage (both kinds), staffing floor (D81/D82/D196/D197/D198/D199/D203/D207 — never below 40 staffable per ACTIVE campaign; 40/POD named inventory still D203), **step-2 delay** (D186 — `seq_delay_details.delay_in_days` must be 2 on the second email; auto-fix via `sequencesForWrite`; canary / pod-control / word-hunt shells and 1-step instrumentation skipped), **merge-tag fill on ACTIVE campaigns that use custom `{{tags}}`** (D180 — multi-offset lead sample + cheap sent-body hole check; pages `merge_tag_blank`, never edits copy). First-check indexes members, yields, honors abort, and caps SmartDelivery enrich at 90s (D251). Reads the shared account book, never its own fetch (D132). Auto-allow clients skip the Allow-generics card (D205 — min-40 stage fills them); remaining generic_unapproved asks in one pass post as **one batched card**. |
| Canon ops | 30 min, weekday 08:00–18:00 America/Chicago | Five `/health` stages, idle-ticked outside the window so a weekend is not OVERDUE (D205/D219): **hold-enforcement** keeps a configured campaign list (Parlay SEGs, Thesis, Cold Call Followup, SG Staffing CANDIDATES — **not** Insight SEG, D246) + Goliath (548611) 0-ACTIVE until 2026-10-15 PAUSED — the only live-campaign PAUSED write besides shells; bounce loop still never pauses (D148). Weekday campaign-watchdog pulses `START` bounce-protection holds outside that deny list (D246). **min40-topup** fills each ACTIVE named-client campaign to 40 *on-week* staffable senders from that client — on-week named first, then already-assigned same-client *on-week* generics shared across that client's ACTIVE campaigns, then a free-pool generic assigned (`client_id` + signature + POD) only while that client's *on-week* POD is short of 40 campaign links (D207/D221/D228/D230). **D250:** min40 indexes seats by campaign and yields every few campaigns so a ~1000-seat × 366-campaign staffable count cannot pin the event loop (prod 2026-10-09 freeze after hold-enforcement). The fill outcome is unchanged. **D252:** the short-campaign fill / pool pick / surplus walk yields and walks that client's seats only; `findReassignablePoolMailbox` is a cached yielding scan with a reject set so an 800-row pool cannot pin the loop for 15–36s per attempt; a stage abort stops new attaches but the run still returns so lastOk can stamp; Slack abort after the shortfall summary stays on the result; ghost pool seats missing from Smartlead inventory are dropped before pick. 10 minutes remains a sane min40 budget once those scans yield. **D230:** min40 assigns only untagged pool generics, or ones already on that same client and POD, to any POD (A or B) under 40. Never take another client's generic. Never retag a generic onto the other POD. Inventory is **40/40**: each POD (A and B) is topped to 40 staffable independently, including the off-week POD. Off-week assigned generics keep `client_id`, POD tag, and signature and do **not** link. After the fill, the **morning named-warm swap** (D230) plus weekday surplus return: one generic per named seat that goes warm, oldest / worst first, and any extras past 40, unlinked and returned to the untagged pool (`client_id` cleared, signature reset, POD tag stripped) so `generic_idle` does not page on legitimate surplus (D225/D228/D230). Never unlink a return that would drop **that POD** below 40 staffable. Off-week named leftovers on an on-week campaign unlink without peeling on-week below 40 (D228). Skip PowerGRYD 592842 and an active 24h TERRL substitute. Auto-allow clients (BCP 542838, TechEvo, Parlay 418274, Insight, EMCOR 574020) execute with no Slack card; everyone else gets one batched Allow-generics ask. **POC engagement** clients on the name-pattern list (default `goliath,deep roots`; Goliath 548611 is not an engagement) auto-fill to **60** weighted seats with no Allow ask, no POD stamp, and the Smartlead `POC` tag (id 531428) reserving the seat to that client (D236). Living POC campaigns include DRAFTED / DRAFT / ACTIVE / START; **CALLER FOLLOW-UP** campaigns (ids or `Gabe Calls |` prefix, D242) and leftover Gabe-named shells are never staffed (not just 4074266). Never retags named seats. Never retags a generic across PODs. Never START/PAUSE. An ACTIVE campaign still under 40 after the pass pages one `ops_alert` per campaign per day. PowerGRYD 592842 is a **full client** (D237) — normal 40/40, rotation, and pause-when-done; not the POC mode. **powergryd-watch** stays alert-only and never START / PAUSE (restaff is min40). **generic-cleanup** uses the same named-warm / surplus return: a pool generic not needed for **that POD's** 40 is unlinked from leftover memberships and returned to the untagged pool — surplus in THAT POD, paused/ended campaign, or a named seat that finished warm (D205/D221/D225/D228/D230). A needed off-week assignment with no campaign links is not cleared. A `POC`-tagged seat reserved to an active engagement survives DRAFTED or ACTIVE and only returns when that POC is marked done (`/run?mode=end-poc`). | **mailbox-type-tags** converges `type:google` / `type:m365` / `type:azure` from the sending domain (tidalstackco.com is Azure/Entra).
| Monitor | Slower cadence | POD-A/POD-B first-tag on **untagged** seats only runs **first** so its handful of decoration writes are not starved by placement pulls (D135/D143/D234 — already-tagged POD-A/POD-B seats are immutable; idle Sat/Sun except Josh-live `/run`), then placement result pulls **that always include `isolation.copyCanaries.*.testId`** (those ids are not in `testedCampaigns`) and may still queue isolation (D158; `Canary copy:` counts as automated; ACTIVE live + canary fill the report cap first; CANON-miss Slack is the 15-minute pager, D163). The **on-ramp cadence is the 15-minute health sweep** (D159), not this loop. DNS advisory audit, lead-runout logging (D52), sending-IP census (D53), canary-fleet adopt while not ready (D86), campaign audit off the shared account book (D132), domain→client advisory audit (D136). Every stage watchdogged into `stageHealth`, overdue judged per stage against its own cadence (`src/lib/stageWindows.ts`); a deleted stage's leftover record is pruned at boot (D131). `/health` names the overdue set (D166). A finished stage checkpoints `lastOk` immediately to a tiny sidecar (`state.json.stamps.json`) so a freeze-kill cannot roll the watchdog back a day; the full `/data/state.json` dump is compact JSON walked in slices off the hot path (D167/D247/D249). Each `stage()` races a wall-clock budget (default 10m; inventory 5; campaign-check-first / scan-backfill 20) and records `timeout after Nm` so consecutiveFailures increment (D247). campaign-check-first also bounds its inspect walk to 8 minutes and leaves the rest as leftovers so it cannot starve the 15-minute pass (D249). It indexes mailboxes by campaign, yields, honors abort, and caps SmartDelivery enrich at 90s so leftover signature writes / test-id fetches cannot eat the 20m race (D251). Health / canon-ops / monitor locks expire (45m / 30m / 3h) with an ownership token so a hung pass cannot block the next cron; `/health` shows `inFlight.{health,canonOps,monitor}.{since,stage}` (D247). MutationQueue jobs time out at 6m; queue depth / oldest wait / 429 streak are on `/health` (D247). A freeze watchdog logs event-loop delay over 1s and `process.exit(1)` if the loop stays blocked 5m or a pass is stuck past twice its max — Railway restart-on-failure must be on (D247). min40-topup and generic-cleanup yield during inventory walks so that watchdog is the backstop, not the recovery path (D250). A short-campaign fill, pool pick, and surplus return also yield; stringify joins in chunks; a Slack/step abort cannot hide a finished walk's lastOk (D252). The monitor's warmup pass is `warmup-gate-monitor` so it cannot invert the health leftover (D247). A mid-chain kill (Railway SIGTERM) resumes leftover stale 6h stages on the **next 15-minute health tick**, skipping anything still fresh in the cycle — never at boot (D122/D167). The 15-minute health chain does the same for leftover late stages (`mailbox-gap`, isolation-branch, pod-cover, reconnect, isolation-buy-resume) so a deploy recycle cannot starve the tail until a lucky full sitting (D211). Resume is **chain inversion** — a later stage older than the newest earlier lastOk — not "an early stage still inside 15 minutes" (D214). Inventory lastOk is not the sitting frontier (skip-if-fresh / a SIGTERM right after the shared-book fetch); newest is taken from the rest of the loop so a newer inventory stamp cannot resume at client-rest and hide a campaign-health → pod-cover interrupt (D215; prod 2026-09-30 15:45Z leftover was client-rest). A leftover sitting whose newest non-inventory lastOk is older than the 45-minute health lock is dead — run the full chain; a 24h-old stamp is never "still inside the cycle" (D249). A deploy resets the cron, so the next tick is ~15m later and the D211 freshness gate was already false (prod 2026-09-30: campaign-health 15:11Z, pod-cover 13:13Z). Skip the prefix and continue from the leftover. The 6h cron still runs the full chain; the 15m cron still runs the full health chain when nothing is leftover. `/run?mode=mailbox-gap` is gap-only (not the full health pass, not the 6h mailbox-settings converge). `/run?mode=pod-cover` is the pod-cover-only tick (D214). |

| Needs you | Weekday 8:00am America/Chicago | One `#deliverability` post (D248, merged D220): Cayden spend lumped into one Approve per client (Slack confirm before spend); Josh-only listed separately. Overnight / weekend human asks queue until this post. Does not spend. A missed weekday fire is caught up once inside 6am–8pm CT (D249). |
| InboxKit license sweep | Weekdays 8:16am America/Chicago (D245) | Compare InboxKit mailbox status to Smartlead accounts (address from `username` + `domain_name`; any Smartlead account, connected or not). A seat is lapsed when its status is lapsed / cancelled / inactive or it is `scheduled_for_cancellation` and the cancel date has been reached (on or before today CT). An `active` row with a stale past `renewal_date` is not lapsed. An address with a live row in another workspace is never touched. Hands per-client findings (lapsed seats, plus upcoming cancellations with dates) to Onboarding and Deliverability through state / `/health`, not Slack (D226). Then deletes the lapsed seats from Smartlead and InboxKit with no approval step (D245). Persists every lapsed / scheduled-cancel seat with its date; staffing (min40, POC fill) never attaches a seat that is lapsed or ends within 7 days, and canon staffable counts exclude lapsed seats (D245). The only Slack post is one `#deliverability` line after cleanup: `Found X inboxes that had lapsed; they're deleted from Smartlead and InboxKit.` and only when X > 0 (D222/D226). A missed weekday fire is caught up once inside 6am–8pm CT; same calendar day does not run twice (D249). |
| EOD brief | Once, America/New_York | Per-client sends + spam scoreboard, untagged campaigns needing a human, DRAFT campaigns with leads loaded (D71, D85, D89). |
| Boot | On deploy | **Only** canary attach at 90s touches Smartlead (D122). Everything else waits for its cron. Boot also logs its deploy identity (Railway git metadata) and pages Slack when it is missing or not a main build — the stale-snapshot redeployer's signature (D149). State-only D176 heal writes live retire/cover asks, retired / retire-pending history, and the known missing burned domain (`boldercyperpartnertop.info`) onto `attachBlocks` so restaff cannot reattach after a deploy. |

## Mailboxes

- **Warmup clock**: a mailbox owes **21 days from its InboxKit import**
  (`warmedAt` stamped at import) **or from Smartlead `created_at` /
  warmup start, whichever is later** (D1 clock, D50 duration, D243
  later-of). A seat bought before it was imported still owes 21 days
  from the later Smartlead clock. WARMUP-GATE-EXEMPT and
  PREWARMED_DOMAINS skip the clock (D227/D142). "Warmed
  ≥14d" is **reporting-only** (pool plan / briefs); the wizard live-send
  gate stays **21 days** (D50/D105/D192). The warmup
  gate is **ON** and pulls an under-21-day mailbox off ACTIVE campaigns on
  the health pass (D105). The gate ledgers every pull per membership: the
  same membership pulled 3+ times in 24h means a writer **outside this
  app** keeps re-adding it — logged every pass and named on the EOD brief
  for a human to switch off; the gate keeps pulling meanwhile, but the
  warmup re-enable write happens at most once per account per day instead
  of on every pull (D143).
- **Exempt from that clock**: pre-warmed fleets — every mailbox on
  `PREWARMED_DOMAINS` (crosslaunchco.com, crossscaleco.com,
  cleartechco.com) and every from-name fleet in `EXTRA_GENERIC_MAILBOXES`
  (D19/D142); the canary fleet (which never staffs anyway, D54);
  **and every seat tagged `WARMUP-GATE-EXEMPT`** (D227). That tag
  counts as 21+ days warm for `isStaffableSender`, the generic-pool
  named count, min40-topup, and surplus return — including when
  Smartlead still reports warmup-blocked or a short import clock.
  The tidalstackco.com Azure/Entra fleet Josh tagged that way is
  warm **now**; do not wait 21 days from the 9/29 Smartlead import.
  Their Azure cap stays **2 campaign + 5 warmup** (D219). Pre-warmed
  is a flag only Josh grants — generic-pool membership
  (`EXTRA_GENERIC_DOMAINS`, which also carries the GetIntroduced /
  QuickConnect fleets) never implies it (D142).
- **Client-named domains (D243):** any seat whose sending domain
  matches a client brand/slug (list_clients names plus known slugs:
  goliathcybersecurity, techevolution, salesglider, boldercyber,
  emcor/mesa, cornerstone, parlay, roofs, nutter, insight/joshosborn,
  powergryd, vector, deeproots) is that client's named seat. Tagged
  to that client, split into that client's PODs — already-tagged
  POD-A/POD-B are not re-split (D234). Never GENERIC, never the
  shared pool, excluded from generic cleanup, surplus return, min40
  supply, and the generic-pool canon. Leftover wizard pool records
  migrate into named state on the health / generic-pool pass.
  Domain-client must never re-add GENERIC to these hosts. **Culture Fits 418275
  / culturefits* stays a D192 leftover** pending Josh — do not classify,
  migrate, or retag those seats.
- **Azure toward 40 and ESP mix (D232 / D233):** any Azure/Entra
  mailbox (`type:azure` or tidalstackco.com), generic or named,
  counts as **0.1** of a regular Microsoft 365 mailbox toward a
  POD's 40; every other type is **1** (weighted sum ≥40). Azure
  may only fill or replace Azure or Microsoft (M365/Outlook)
  slots, never Google slots. When a Google seat leaves, only a Google seat replaces it (min40, 24h TERRL sub, named-warm
  swap, pool assignment).
- **Converged every pass**: campaign sends/day (warmups excluded,
  D24/D183/D219) — tagged `type:google` / `type:m365` /
  `type:azure` from the sending domain (weekday
  `mailbox-type-tags`; `tidalstackco.com` is Azure/Entra).
  **Azure/Entra 2** campaign/day and **5** warmup/day;
  Outlook / Microsoft **15** campaign/day (M365; warmup unchanged);
  **Google** stays `MESSAGE_PER_DAY` (30) and the standing warmup.
  **D232 — Azure weight:** any Azure/Entra mailbox (`type:azure`
  or tidalstackco.com), generic or named, counts as **0.1** of a
  regular Microsoft 365 mailbox toward a POD's 40. Every other
  type counts as **1**. The POD target is a weighted sum of at
  least 40. Same weights apply to staffable counts, Canon
  `understaffed`, min40 need, surplus return, the named-warm
  swap return trigger, and the 24h TERRL substitute (only link
  a sub when weighted on-week staffable is under 40; prefer a
  non-Azure generic).
  **D233 — Azure ESP slot:** Azure may only fill or replace
  Azure or Microsoft (M365/Outlook) slots, never Google slots,
  so the POD's ESP mix holds. When a Google seat leaves, only a Google seat replaces it. Same rule in min40, the 24h TERRL sub, named-warm swap, and pool assignment.
  Do not drop the global constant to 15. M365-at-15 is compliant,
  not a `mailbox_volume` finding. On a Microsoft **550 5.7.233**
  (TERRL) from a tenant: every seat on that tenant goes to
  `max_email_per_day=0` for **24 hours (rolling)** but stays
  linked and keeps its POD tag. After the window the seat resumes
  its **normal type cap** (Azure 2, M365 15, Google unchanged).
  Do not record a learned limit and do not lower the mpd after a
  bounce. In the same campaign and on-week POD, temporarily link
  **one** extra warm (21+ days) generic from that **same client's**
  generics, signature and sender name set for the client, so the
  POD runs at **41 linked / 40 sending**. Never retag named seats.
  Never move seats between PODs. Never borrow another client's
  generic. Record the temp substitution (stopped seat, substitute,
  campaign, client, stop time). When the 24 hours are up, restore
  the stopped seat to its type cap and unlink the substitute so
  the POD returns to 40. If no clean same-client generic is
  available, leave the campaign at 39 sending and name it on the
  EOD post (`no substitute available, at 39 sending`). There is
  **no 7:15pm CT / 00:15 UTC restore to 15** (D218). A seat
  on the **D148 bounce-hold list** (Smartlead account id) is
  skipped by mailbox-gap, health, fan-out, top-up, min40, and
  canary setup while the TERRL window is open (D212/D218/D219).
  The 24h window is what those writers must skip; after it the
  type cap resumes (D219).   The TERRL EOD note stays a weekday ~5:30pm CT `#deliverability`
  post grouped per client listing every inbox that hit 5.7.233 that
  day and was paused — nothing on days with no such bounces, never
  per bounce. Informational short-staffed / stage-overdue /
  CANON-miss / bounce-burst / canary-registered / hold-paused /
  copy-check no-fix / placement / lead-expired posts go to
  `DELIVERABILITY_LOG_CHANNEL` (or one daily thread in
  `#deliverability`) — not as standalone `#deliverability` cards
  (D248). Short-staffed posts only on change, one line per client.
  A **5.1.8 / AS(42004) tenant outbound block**
  (`tenant_outbound_block`, never `tenant_rate_limit`) holds every
  seat on that tenant at 0 with **no automatic restore** — the 7:15pm
  D183 write, mailbox-gap, fan-out, top-up, and min40 skip them until
  a human clears the hold (D213). mailbox-settings may write 0 only
  to keep those seats at 0. `#campaign-watchdog` gets one page per
  tenant (delist or replace).
  **Every hold is evidence-per-seat** (D224). A HOLD tag, an mpd-0
  hold, a bounce-hold id, or a TERRL hold must name each seat and
  attach that seat's own reason from a fixed list: (1) a hard bounce
  or block on that mailbox or its tenant (`5.7.233`, `5.1.8`, and
  the event id), (2) SMTP or IMAP auth failure on that account,
  (3) its domain is retired or a bad sender (exact domain only),
  (4) its InboxKit seat is lapsed, cancelled, or inactive, (5) a
  named blacklist hit on that domain (SURBL excluded), (6) warmup
  under 21 days or warmup reputation below threshold. A seat
  without its own evidence is rejected and is never held by
  pattern, substring, or client. Each hold stores its reason and
  evidence and expires when the reason clears, or at 30 days at
  most. Rejected seats post in one `#deliverability` note for
  review. There is no 5 / 10 / 25% numeric hold cap.
  Write as `max_email_per_day`; read as
  `message_per_day` (D24). 10-minute minimum gap (D30/D35) — held at
  BOTH levels: the mailbox field every health pass, and campaign
  `min_time_btwn_emails` written back to the floor by the checker on
  sight (D138; a sender on N ACTIVE campaigns still paces per
  campaign — the fan-out multiplication is a known, deliberate
  residual, capped by the type-aware daily cap). CALLER FOLLOW-UP
  class senders (`GABE-VM-RESERVED` today) skip that cap write —
  their `message_per_day` is manual (D241/D242). warmup ON for every mailbox **except the
  canary fleet, which is forced OFF** (D83), plain two-line signature
  `First Last\n{Client Brand}` (D31). On a living campaign, an empty,
  one-line, extra-line, or foreign-client signature is a `mailbox_sig`
  finding and is **written on that check pass** (D74/D125) — never left
  waiting for the 6-hour converge. **Copy that contains `Insight`**
  (D178): if sequence `email_body` / variants include the exact
  substring `Insight` (capital I), D92 does **not** write
  `%signature%` / `{{Signature}}` — those expand to the shared
  SalesGlider mailbox brand. The same pass **strips** those
  placeholders if present and **writes a plain close into the
  sequence body, before any P.S. lines**: `Josh Osborn` then
  `Insight`. A close that is already that pair is left alone.
  Mailbox / email-account signature fields are **never rewritten**
  on this path for mailboxes that staff ACTIVE SalesGlider
  campaigns (D31/D92 still apply there). **Insight is Smartlead
  client 582890** (D192) — Josh personal domains only; mailbox
  signature `Josh Osborn` then `Insight`. **SalesGlider stays
  345263** (`salesglider*` only). Insight ≠ SG. One-client
  (D26) plus the named-id attach gate keep them from mixing:
  josh-personal never fans out as 345263 supply onto Insight.
  **D184 exclusive-blank Insight staff is retired / obsolete —
  never revive** (empty exclusive seats inside 345263). Do not fleet-converge
  salesglider* domains to empty.
  `desiredMailboxSignature` for SalesGlider stays Name /
  SalesGlider. Do not re-introduce `%signature%` into Insight
  sequences. `insight` / `INSIGHT` alone do not match. Other
  clients' copy without that substring still gets D92.
- **Send window** (D182): live campaigns send **Monday–Thursday
  08:00–19:00 America/New_York**. No Friday, no weekends. Smartlead
  is a single window — do not invent Friday. `min_time_btw_emails`
  stays 10 and `max_leads_per_day` stays 10000. The build skill
  writes this on setup.   Custom non-standard windows (Cold Call
  Followup-style afternoon) are left alone — there is no schedule-window converge, so a hand-set afternoon campaign is
  not overwritten back to the standing window. **CALLER FOLLOW-UP
  (D242)** is Mon–Fri 07:00–20:00 America/Chicago,
  `min_time_btw_emails` 3 — never converge that class back to
  Mon–Thu or the 10-minute canon gap.
- **Sequence delays** (D186): step 1 stays `delay_in_days: 0`.
  Step 2 must be **2 days** on every client campaign that has
  a second email. Canary shells, pod-control shells, the
  word-hunt shell, and 1-step instrumentation are skipped.
  Campaign-check flags `step2_delay` and writes step 2 back
  to 2 when safe (same `sequencesForWrite` path as other
  sequence writes). Do not change step 3+ delays.
- Disconnected mailboxes are re-authed every health pass; reconnect results
  Slack as action results (D94).

## Staffing

- **One client per sender, hard.** An inbox sits on every ACTIVE campaign of
  exactly one client (plus paused shells).   **Exception (D242 / D244 CALLER
  FOLLOW-UP):** seats tagged `GABE-VM-RESERVED` (or the configured
  `CALLER_FOLLOWUP` sender tag) — Gabe Lopez voicemail follow-up,
  gabriel@ 24255314 / 24255318 / 24255344 plus later gabe@ seats —
  sit in SalesGlider 345263. **Only the three bridge gabriel@
  seats** may be linked to all three `Gabe Calls |` campaigns
  today. Owned `gabe@` seats attach only to that client's Gabe
  Calls campaign after 21 warm days — the reserved tag does not
  skip those checks and does not allow cross-client attach.
  Unlisted reserved `gabe@` domains never attach. That class is
  the one-client exception: peel and campaign-check cross-client
  skip it. No mutating stage unlinks, links, retags, or rewrites
  them except stripping illicit POD-A/POD-B (D244): one-client
  peel, campaign-check signature write, warmup-gate pull,
  client-rest A/B, fan-out to other campaigns, mailbox-settings
  cap / gap / signature / from-name. Their `message_per_day` is
  managed by hand (ramp to 35 on Oct 12). Foreign-client memberships are
  pulled every 15 minutes and the signature reset to the owner (D26, D75)
  **unless** that pull would drop the ACTIVE campaign below 40
  *staffable* senders (D197/D198/D199/D207/D209). Raw membership
  (disconnected / canary leftovers) is not surplus. A rest
  *record* on a seat that is still attached does not shrink the
  floor or exempt the peel (D209) — only a successful detach
  benches it. **Same-client generics MAY multi-link (D207/D209).**
  No stage unlinks a seat from an ACTIVE campaign only because
  it is also linked to another campaign of the same client.
  CultureFits and Vasco GENERIC seats that already staff a named
  client's ACTIVE campaigns are normal pool seats, not leftover
  dirt. A named-client seat (e.g. techevolution* tagged to
  TechEvo 521881) **and** that client's own generics
  (`client_id` = that client, client signature) **may** sit on
  every ACTIVE campaign of that same client, exactly like named
  seats. D200 exclusive-attach / exclusiveExtras peel is
  retired. Still peel: a seat whose `client_id` / tag is a
  **foreign** client on this campaign. Never link a generic to
  a different client's campaign. The ≥40 staffable floor still
  gates every peel of a staffable same-client seat
  (D199/D207/D209). Exceptions that may still come off below
  40: disconnected / SMTP-fail, cross-client, HOLD/RETIRE-tagged,
  warmDays < 21 (except seats tagged `WARMUP-GATE-EXEMPT`).
  Generics are a **fleet-wide pool** (D221), not a POC-owned rotating
  set (D76's "belong to Goliath" read is retired). A generic belongs
  to a named client only while `assigned_client_id` is set to fill
  that client's POD to 40. A leftover Generic/POC client_id is
  cleared, not rewritten (D160). While assigned, the seat keeps that
  client's signature; when it returns to the pool both clear.
- **Floor = 40 on-week staffable senders per ACTIVE campaign**
  from that campaign's own client (D58, D82, D196, D197, D198,
  D199, D203, D207, **D217**). **Canon staffable** (D217) is a
  linked seat that can actually send on the on-week POD: SMTP
  and IMAP not failing, `max_email_per_day` / `message_per_day`
  > 0, warmup ≥21 days when a clock is readable (`WARMUP-GATE-EXEMPT`
  counts as 21+, D227), correct client
  (or that client's assigned fleet-pool generic), on-week POD-A/POD-B tag
  (off-week tagged seats do not count; untagged seats are not
  excluded), not a canary, not HOLD/RETIRE, not InboxKit-lapsed
  when the store knows. Raw linked membership is not staffable.
  Inventory target is **40 POD-A + 40 POD-B** staffable
  seats per named client (D203/D228) — named first, then
  fleet-pool generics assigned only while **that POD** needs
  them (D221). Campaigns link only the on-week POD. The
  off-week POD keeps its assigned generics (`client_id`,
  POD tag, signature) with no campaign links. Off-week
  named leftovers on an on-week campaign unlink without
  dropping on-week below 40. **Canon pages understaffed only when
  on-week staffable is under 40** — not when named on-week
  inventory is 46 or 48 and the campaign already has 41/41
  on-week staffable (D196's max(named on-week, 40) page floor
  is superseded for paging). Same-client generics share so a
  client with <40 named seats can still staff every campaign.
  Operational inventory floor is max(half-client-named-per-pod
  structural rest, **40 per POD** via named + fleet-pool generics).
  Off-week POD's 40 stay assigned and rest ready. If bad senders are
  peeled, restore each ACTIVE campaign back to 40. Each POD
  also keeps an **ESP mix floor** (D203/D233):
  when the client has both Outlook and Gmail, neither ESP may sit under ~1/3 of that POD's seats (**14 of a 40-seat POD**).
  Azure counts as Microsoft for that mix and must never take a Google slot.
  A POD must not go monoculture. D192 ESP-balanced ~50/50
  across A/B *within* each ESP still stands — this is a per-POD
  mix floor on top. An ACTIVE campaign whose on-week staffable
  mix breaks that floor is an `esp_mix` Canon finding (D217).
  A generic or named seat whose `client_id` is a **foreign**
  client is a `cross_client_membership` Canon finding (D217) —
  generics never cross clients. Peels consult the **staffable attached**
  count on that ACTIVE campaign, never raw `campaign_ids`
  length as a surplus counter (D199).   Same-client
  `campaign_ids.length > 1` is not a peel reason on named
  seats **or** that client's generics (D207/D209). Same eligibility
  as before (connected-capable, not held, not retired, not
  attach-blocked, not canary — D99, D176, D193). ESP-balanced
  A/B (D192) can leave B smaller than half (94 eligible →
  A48/B46); that is not a Canon short when on-week staffable
  is already ≥40 (D217). Understaffed means this ACTIVE
  campaign has fewer than 40 on-week staffable senders —
  SMTP-fail / mpd-0 / off-week / foreign seats do not fill
  the floor.   Keep "half this client's inboxes" only when the
  numbers match; otherwise "on-week staffable 40" / on-week minimum 40. No named-client
  exceptions; Vasco is nobody special (D82). PowerGRYD 592842
  is a full named client (D237) — 40/40 like everyone else,
  campaigns may PAUSE when done, not a POC engagement.
  **POC engagement** (D236): a name-list match except Goliath
  548611, not yet marked done, gets **60** weighted seats
  from the shared pool, no PODs, no A/B, no 40/40 math.
  Signature is `<from_name>\n{full client brand}` (Deep Roots
  Capital passes the brand check). The `POC` mailbox tag
  reserves the seat to that client. Release only via
  `/run?mode=end-poc` (or removing the name from the list).
  The old global 50 floor is dead.
- **Fan-out**: a client-owned inbox belongs on every ACTIVE campaign for its
  client even if it currently sits on zero campaigns (D84). Insight
  (582890) and SalesGlider (345263) are **different clients** (D192)
  — do not fan 345263 inventory onto Insight campaigns; do not rewrite
  Insight campaign `client_id` off 582890. Insight off-week seats
  unlink like any other named client (D229). BCP-owned domains
  count as BCP even with no `client_id` (D99). Resting inboxes are skipped,
  and so is anything that owes warmup days — staffing never hands the gate
  its next pull; a fresh import waits out its 21 days even if its campaigns
  sit under floor meanwhile (D139).   **Attach-blocked** senders
  (AS(42004) / `sender_blocked` / restricted / bounce-isolation unlink)
  are skipped the same way — fan-out, top-up, client-rest, and one-client
  restore must not put them back (D176). INFRA isolation stamps the
  block when known-good condemns a sender domain (`bounce_isolation`);
  a retire unlink writes `burned`; boot heals live asks plus known
  missing blocks so a deploy does not wait for another sample.
- **Rest (pods)**: each client's **named** senders split into a
  **static** even A/B (D43/D203) that is **ESP-balanced ~50/50 within Outlook and within Gmail**
  per non-generic client (D192) — not an alphabetical-only half.
  Never retag or move named seats between POD-A and POD-B to staff
  the on-week campaign (D203/D234). **D234:** a named already-tagged
  POD-A or POD-B seat is immutable — only an untagged seat may
  receive a first POD tag. No job (pod-tags, min40, rest, rotation,
  ESP-balance) may change A to B or B to A. Weekend writers
  (pod-tags, client-rest) idle Sat/Sun except Josh-live `/run`.
  **D235:** a generic carries a client and POD tag only while
  staffed. Returning it to the untagged pool (surplus, named-warm
  swap, cleanup, 24h TERRL sub release) clears POD-A/POD-B along
  with `client_id` and signature and records `released_at`. The
  D234 lock still allows that strip, and still allows a first POD
  tag on an untagged pool generic being assigned. Named seats stay
  immutable. Generics are not part of that named cut.
  On top of the D192 cut, each POD keeps the D203 mix floor: when
  both ESPs exist on the client, prefer neither Outlook nor Gmail
  under ~1/3 of that POD's 40.
  Off-week comes OFF **ACTIVE** client campaign memberships
  only — never left on at 0/day, and **never when an ACTIVE
  campaign would drop below 40 **staffable** (D197/D198/D199/D203/D207/D209;
  surplus above 40 may still rest). Do not mark a floor-blocked
  seat as resting — that made the next pass treat it as
  non-staffable and peel it below 40 (D209). **PAUSED and STOPPED keep
  their senders (D207, supersedes D169).** A bounce auto-pause
  must not strip the on-week half (Peterson #3798229 lost 37 of
  40 seats at the next client-rest tick). Last-account guard
  stays. **D189 retired (D229):** Insight campaigns are not
  rest-sticky. Off-week seats unlink from Insight; campaigns
  keep only the on-week POD (D228). The D184/D192 mix stays —
  Insight staff never restore onto ACTIVE SalesGlider, and
  ACTIVE SG staff never restore onto Insight. Engagers / other
  SalesGlider ACTIVE rest is unchanged. Warmup stays on; resting is not staffable.
  On-week **named** seats **and that client's generics** staff
  **every ACTIVE** campaign for that client (D59/D207),
  including boxes whose only current memberships are
  PAUSED/STOPPED — do not detach them from the paused/stopped
  campaign. D200 exclusive one-ACTIVE restore and
  exclusiveExtras peel are retired. Client-named BCP domains
  (`boldercyper*`) are client inventory, never skipped as generics
  (D99/D169). Excluded / canary / pod-control shells are not touched.
  **Goliath 548611 and active POC-engagement clients do not
  rotate** (D223/D236). PowerGRYD 592842 rotates like any
  full client (D237).
  A seat tagged both POD-A and POD-B is flagged to
  `#deliverability` on weekdays; the wizard does not pick a side.
  The split is visible in Smartlead as POD-A/POD-B mailbox tags,
  first-tagged 6-hourly on untagged named seats only (D135/D234) —
  decoration for humans; never a retag. **CALLER FOLLOW-UP
  reserved seats never receive a POD tag** (D244); pod-tags
  strips POD-A/POD-B that already landed on them.
  Assigned generics also carry a POD so allocation can top A and B
  independently; that tag is not rotated across PODs (D221/D230).
  **There is no separate generic send-clock** (D43's ~14-day sit is
  retired). A generic assigned to POD-A stays on A, rests and
  sends with A, and never flips to B (D230).   True canaries and Culture Fits / TJ / Vasco leftovers stay
  `client_id` null (project generic pool — D192). Goliath
  client-named hosts are named seats for 548611 (D243).
- **Generics (D230, governing):** Generics are one shared pool,
  tracked in a table. A generic attaches to ONE client and ONE POD,
  A or B, whichever is under 40, and never rotates PODs. It carries
  that client and POD tag **only while staffed** (D235). It stays
  with that POD until the client's branded named seats fill that
  POD back to 40, then it returns to the untagged pool. While
  tagged, no other client can use it. Never pre-split generics
  across clients.
- **Generics** are **ONE fleet-wide pool** (D221/D230/D231). The wizard
  tracks every generic seat in `state.genericSeats` (the `generics` table
  in `src/state/store.ts`, one row per seat):
  seat id (`sl_account_id`), `email`, `assigned_client_id` (nullable),
  `assigned_pod` (A/B, nullable), `assigned_at`, `reason`, and a
  `released_at` history, plus `provider`, `warm_ready_at`, and
  `assigned_campaign_id(s)`. **Every** generic assign and release
  (min40, TERRL sub, named-warm / surplus return, cleanup) goes
  through that table — never ad hoc. A check blocks any generic
  tagged to two clients (`generic_multi_client`) or assigned
  outside the table (`generic_outside_table`). Health seeds the
  table from live Smartlead inventory. A
  generic gets a client and POD assignment **only** when
  **that POD** is short of 40 staffable senders
  (D228 — each POD independently, so inventory is 40/40,
  not only the on-week cylinder). While assigned,
  no other client may use it (no double sending). Same-client
  multi-link across that client's ACTIVE campaigns is still
  allowed for the on-week POD (D207) — `assigned_campaign_ids`
  is plural. Off-week assigned generics keep `client_id`,
  POD tag, and signature with **no** campaign links. As soon as
  it is no longer needed (surplus beyond 40 staffable in THAT
  POD, campaign paused or ended, replaced by a named seat that
  finished warm), **min40-topup and generic-cleanup** unlink it on a Chicago weekday and return
  it to the untagged pool with `client_id` / `assigned_client_id`
  cleared, the signature reset, the POD-A/POD-B tag stripped, and
  `released_at` recorded (D225/D228/D235) — that is what stops
  `generic_idle` paging on legitimate surplus. A needed
  off-week assignment is not surplus just because it has no
  campaign links. Never unlink a
  return that would drop **that POD** below 40 staffable.
  Never pre-split the pool across clients. Never pre-split
  generics across clients. Never hold an idle generic for a
  client. Allocation is **per POD**: POD-A and POD-B are each
  topped to 40 independently. Generics are never retagged
  across PODs and never rotate PODs (D230). **There is no
  separate generic send-clock.** On a POD flip a generic
  unlinks and relinks only with its own POD. Return is the
  **morning named-warm swap**: one generic per named seat
  that goes warm, oldest / worst first, never dropping the
  POD below 40; surplus beyond 40 also returns to the
  untagged pool. Rotation unlinks off-week campaign
  memberships only; it does not clear the off-week
  assignment or move the generic to the other POD.
  Named client campaigns stay **client-inbox first**, then
  fleet-pool generics fill each POD to 40 (D221). **D193's
  "named clients never receive generics / POC-only" read is
  retired (D229).** Leftover D134 Slack / retire-tap approvals
  are still not attach permission. **D203 narrows D193**
  for the min-40 fill path: exclusive generic + client-sig seats
  are thin per-POD top-up when that POD's named half is under 40. **D205/D207** execute
  that fill for **auto-allow** clients (BCP 542838, TechEvo,
  Parlay 418274, Insight, EMCOR 574020) without an Allow-generics
  card. Prefer named first; when topping a short campaign, prefer
  the ESP that is under the ~1/3 mix floor. SalesGlider with ample salesglider*
  named inventory (each POD already ≥40 named) must not carry pool generics. Do **not** rotate the same
  generic onto a **different** client's campaign. Leftover D134
  Slack / retire-tap approvals are a historical record, not attach permission.
  If a client lane is understaffed and no
  eligible *named* senders remain, fill that POD up to 40 from
  the free pool — do not borrow another named client's
  mailboxes. **Exceptions (D221/D236):** an active POC-engagement
  assignment (`poc_engagement` / `POC` tag) is not idle and is
  not returned until that POC is marked done. The
  temporary 24h-stop substitute (same-client extra generic while
  a 5.7.233 seat is at 0) stays assigned until the 24h window
  ends, then releases. PowerGRYD 592842 is not a dedicated
  exception (D237).   A generic assigned to a client that does
  not need it for that POD's 40 is a `generic_idle` finding. The
  **named staffable** count that decides idle (D239) matches Canon
  staffable: 21-day warmup gate (`WARMUP-GATE-EXEMPT` still counts),
  exclude `GABE-VM-RESERVED`, exclude the canary fleet.
  `GABE-VM-RESERVED` / CALLER FOLLOW-UP is also a **hard write
  exemption** (D241/D242): never unlink / link / retag / rewrite
  those seats; a needed kill pages Josh first. A
  generic assigned to more than one client is a
  `generic_multi_client` finding. A generic tagged in Smartlead
  without a matching table assignment is
  `generic_outside_table`. Those three are core CANON misses —
  `/health` goes no and Slack pages once per incident.
  **Exception (D197/D199/D203/D207/D209/D221):** exclusive generic + client-sig seats
  filling a POD shortfall must not be peeled as foreign Goliath
  while they are needed. Surplus pool generics above 40 per POD
  return to the fleet pool — they are not kept because they were
  once dedicated (D198 keep-above-40 is retired for pool
  generics). `pod-cover` does not unlink live ACTIVE seats. A
  seat linked to a **second client's** campaign still peels that
  foreign membership (`exempt` from the floor). Same-client
  extra links no longer peel (D207 supersedes D200). An ACTIVE
  campaign under 40 staffable is an `understaffed` finding.
  After a min40-topup pass that cannot fill it (pool exhausted),
  Slack one `ops_alert` per campaign per day naming campaign,
  count, and shortfall. The **staffable peel** floor is the same
  count `/health` uses — disconnected leftovers must not look
  like surplus. Every `removeEmailAccountsFromCampaign` on an
  ACTIVE campaign consults `detachWouldBreakStaffableFloor`.
  "Generic" and "POC" are **mailbox tags**, never
  Smartlead clients — Josh does not pay for pool labels (D160). A box
  tagged GENERIC or POC is a generic to every classifier (also: pool
  domain, pool-brand host, `EXTRA_GENERIC_DOMAINS`, pool state, leftover D142 client_id
  until detached). The `POC` tag (id 531428) additionally **reserves**
  the seat to its `client_id` (D236) — free-pool pickers will not
  take it for another client. One-client never writes those boxes onto a client
  record; leftover Generic/POC `client_id`s are cleared except an
  active engagement reservation. The mailbox-side
  owner re-point to a leftover D142 POC *client record* stays staged
  and is now moot (D142).
  A domain-retire tap is one fell swoop (D150): pull the burned
  inboxes, buy a replacement domain whose Google/Outlook mailbox mix
  matches what was retired, and records a D134 generic-backfill
  approval for the campaigns it cut. That approval does **not** attach
  pool senders onto a named client campaign past that POD's 40
  (D193 leftover D134 record is not attach permission) — cover is the
  client-named replacement (D161). Assigned 40/40 generics stay
  (D221/D229). **InboxKit
  allows one ESP per domain** (D175): isolation-buy never requests
  Microsoft on a domain that already has Google (or the reverse). A
  fresh replacement is provisioned as one ESP (majority of the retired
  mix). The unmatched ESP is skipped and the stage completes — no
  second domain without a spend approval, no overdue retry loop.
  **A client-domain
  retire MUST buy a client-named replacement for that client** (BCP →
  `boldercyperpartner*` / `getboldercyperpartner*` / `tryboldercyperpartner*`
  style names already used for that client; Goliath → `getgoliath*` /
  `goliathcybersecurity*` style) — never a generic
  crosslaunchco / pool spin. Generic spins are only for generic/pool
  domains (D161).   Cross-client
  top-up is a compensated **move**; same-client is additive. (The old
  recovery-swap system and its reservations are deleted, D130.)
  **Ownership is who staffs the domain, not the pool plan** (D173): a
  sending domain whose live mailboxes belong to one real Smartlead
  client is that client's domain for retire eligibility, replacement
  naming, and generic-cover — even when it appears on the generic
  pool list. The plan is the fallback when mailboxes name no real
  client. A plan-vs-mailbox conflict is logged; the mailboxes win.
  **Goliath / client 548611 burned domains follow the normal Retire
  ask** (D181, reversing D174 never-retire): AS(42004) / known-good
  evidence opens `retire_domain` like any other client
  (D146/D150/D161/D173/D176/D179). Replacements are client-named.
  The Oct 15 Goliath *campaign* PAUSE hold is unchanged and separate
  — this is not a campaign start/stop rule. Cover-buy without retire
  remains the fail-#1 buy-ahead path, not a protection carve-out.
  A replacement buy that fails after a pull stays in
  `awaiting_purchase` and the 15-minute resume retries it — never
  parked in `approved` with no path forward (D174). Porkbun
  availability checks are process-wide locked (sleep before the
  request) and retried on the 10-second rate limit.
- **Retired domains stay off** live campaigns forever; replacements owe the
  21 days (D65). A known-retired domain never opens a fresh actionable
  Retire ask or a second replacement buy when old / recurrent 5.1.8
  evidence reappears — Slack suppress, deploy remind, and the confirm
  tap are all no-ops (D179). **Attach-blocked** domains stay off live
  campaigns (D176) — restaff must not put them back, including after
  a Goliath retire. Cover is new inventory, not reattach.

## Pulls and pauses

- **Kill-only** (D51): placement %, bounce %, blacklists, and leftover
  HOLD-UNTIL tags do NOT pull a mailbox off an ACTIVE campaign (D128). The
  only removals are Josh killing a mailbox / retiring its domain, and the
  21-day warmup gate (D105). Health backfills to the floor afterwards.
- 80% same-ESP live / 85% launch (promo tab = miss) are **readings** — the
  launch bar blocks QA-unpause of a new campaign (D46/D106), the live number
  never rotates (D32/D51). Never use the blended all-ESP score for anything
  (D32). A live or canary-copy same-ESP reading under 80% on an ACTIVE
  campaign **queues isolation** (copy suspect → COPY word hunt / INFRA
  sender-domain path), and so does a dominant bounce `content_block`
  (D158). The score→suspect→evaluate pass runs on the **15-minute
  health sweep** (D159) so a send-day miss is remediating within one
  cycle — live % still never rotates (D51).   A still-ugly **ACTIVE** campaign whose
  latest isolation run is INCONCLUSIVE, or whose `evaluatedAt` is set
  but the latest run is not COPY/INFRA/HEALTHY covering the ugly,
  **re-queues** (D164). The isolation-branch sweep re-evaluates those
  existing suspects on the 15-minute loop even when `evaluatedAt` is
  set and even when the live campaign is PAUSED — placement *new*
  queue stays ACTIVE-gated. A copy-canary row with emails but no
  `testId` is healed so `unwarmedCopyFineAcrossEsps` can return a
  reading. COMPLETED / STOPPED / PAUSED do **not** get
  isolation INCONCLUSIVE Slack pages or D164 re-queue — they are not
  sending; PAUSED Slack/re-queue is skipped because D40 never auto-resumes (D165).
  First detect / mark-suspect and each isolation
  verdict transition **pages Slack once per campaign per incident**
  (D163) — not every 15 minutes.
- There is **no per-sender bounce pull** (D79 retired D5), **no campaign
  bounce band** (D88 retired D78/D80), **no paused-campaign bounce hunt**
  (D91 retired D29). The D90 bounce loop above is the only bounce actor.
- **A manual pause or stop is never auto-resumed** (D40). Only protective
  pauses we recorded in `pendingResumes` may resume, and never a STOPPED
  campaign. QA-unpause may START a PAUSED POC campaign after signature QA
  passes (D77/D82), never below the 85% launch bar or without a living
  placement reading, never one the bounce loop paused (D106/D128), and
  never a **standing hold** (D205 — configured campaign ids / name
  patterns, plus Goliath 548611 0-ACTIVE through 2026-10-15). Health
  pending-resume will not START a held campaign either. Hold enforcement
  may PAUSE an ACTIVE held campaign and Slack one line; that is the only
  live-campaign PAUSED write besides shells. The bounce loop still never
  pauses (D148).

## Canary + placement instrumentation

- **Canary fleet** (D54/D238/D240): living fleet is **10 seats** (5 Google
  + 5 M365 on 4 domains after the 2026-10-05 swap), warmup permanently
  off (D83), registered `copyCanary`, **hard-locked** — never staffing
  supply, never a member of a live campaign (D55), never `client_id` /
  POD / GENERIC tags. Identify by registered fleet membership first,
  then the Smartlead `CANARY` tag, then the two-line `Canary` signature
  as a backstop. Minimum usable posture is still **one Google domain +
  one Outlook domain**. Replace the registry only via sanctioned adopt:
  Smartlead `CANARY` tag and/or `CANARY_FLEET_EMAILS`,
  `/run?mode=adopt-canary-fleet`. The 2026-10-05 contaminated 6-seat
  fleet (`getcrosslaunchco.info` / `crosslaunchcoget.info`: leilasanchez,
  kwamelopez, aminarodriguez, marcusrossi, jasminecosta, ninajefferson)
  is on the **released list** (hardcoded + `RELEASED_CANARY_FLEET_*` +
  state) — never re-adopted, never rebuilt from the original purchase,
  and **not canaries for D238**. After release they are normal generics:
  no signature rewrite to Canary, no forced warmup-off, no
  `canary_warmup_on` page. Until the new fleet is registered, copy tests
  may have no senders — that is **one fleet-level notice**
  (`canaryFleetDown`), not per-campaign spam (D85/D240). min40, fan-out,
  top-up, generic-pool, POC, pod-tags, and domain-client audit must not
  touch a *living* canary. A living canary linked to any non-canary-shell
  campaign, or with warmup on, is a core Canon miss (`canary_on_live` /
  `canary_warmup_on`) and pages Slack (D238). A hand-bought replacement
  is adopted automatically (D86/D240).
- **Canary-copy tests**: one recurring SmartDelivery test per ACTIVE
  campaign named `Canary copy: #{liveId}`, senders = the fleet, copy = that
  campaign's live sequence. The test hangs on a **paused per-campaign Canary
  shell** carrying that copy, with one unique instrumentation seed lead
  (`canary.instrumentation.{shellId}@…`) (D114–D120). Shells stay PAUSED —
  the checker converges a non-paused shell back to PAUSED itself (D131) —
  and are invisible to START/top-up/fan-out/bounce/board.
- **Known-good pod controls**: versioned no-offer control email on the paused
  **Pod control shell** (D56); every serving inbox must sit on a living
  known-good test — coverage is per email, and newcomers to a pod get
  supplemental tests on the next pass (D131); sitters are members of the
  shell only.
- **Placement tests**: one recurring schedule per campaign (`every_days: 1`),
  unlimited quota (`TOTAL_TEST_QUOTA=0`, D45), ≤50 senders per test (API
  limit), reconciler stops tests of inactive campaigns (D8/D45). A missing
  test is backfilled on the same health pass that finds it (D116). A state
  test-id mark covers a campaign only if the living test is that campaign's
  (or the test has no campaign id at all) (D121/D123).

## Diagnosis: infra vs copy vs word

- A campaign in spam is a flag, not a verdict (D49). The flag is raised by
  reply-collapse (D69), by same-ESP inbox under 80% on that campaign's
  canary-copy test or live placement test, **or** by a dominant bounce
  `content_block` (D158) — shells stay off the live board (D126), but
  canary-copy ugliness for an ACTIVE live campaign counts. Prefer the
  **copy** path on `content_block` + ugly canary unless known-good also
  fails an ESP (then infra). The on-ramp is the 15-minute health
  sweep (D159), not the 6-hour monitor or daily DeliveryWatch.
  Read three things on the same domains: the campaign-copy test per ESP, the
  known-good control per ESP, and the unwarmed canary fleet sending that
  same copy (D93, D96).
  - Known-good also failing an ESP → **infra**, not a word.
  - Unwarmed canaries land the copy while live senders fail → infra.
  - Campaign copy fails an ESP, known-good fine everywhere, unwarmed canaries
    also fail that copy → **word hunt** (deletion tests on the isolation
    rig). Variants ride a paused **DW Word Hunt Shell** with the isolation
    mailboxes attached — SmartDelivery now requires `campaign_id` +
    `sequence_mapping_id` + `provider_ids`, so custom-sequence-only posts
    are dead (D151). A COPY verdict **starts teardown** when the rig has
    mailboxes — do not leave `teardownStarted: false`. An unarmed rig
    waits and asks Josh once to buy its isolation domain — the tap is
    the approval, the buy is spend-gated, and the bought domain arms
    the rig from state (`ISOLATION_DOMAIN` still overrides) (D137/D158).
  - No unwarmed reading yet → wait. Do not hunt.
  - Latest run **INCONCLUSIVE** (or `evaluatedAt` set but the latest
    run is not COPY/INFRA/HEALTHY covering the still-ugly score) →
    **re-queue** on the next 15-minute pass **when the campaign is
    ACTIVE** (D164/D165). The isolation-branch sweep still **re-reads**
    existing suspects including PAUSED lives already flagged (D164).
    Do not treat an old COPY stamp — or `evaluatedAt` alone — as a lock.
    COMPLETED / STOPPED / PAUSED stay quiet — no INCONCLUSIVE Slack
    page, no D164 re-queue. Missing copy-canary `testId` is backfilled;
    without it the unwarmed reading stays null and the verdict cannot
    leave INCONCLUSIVE.
- The hunt runs autonomously; Slack fires **once** when it has the word:
  receipts, the **exact phrase being replaced**, a **substitute edit that
  keeps the line’s job** — a job classifier (spam-token / gift-or-experience
  offer / CTA / generic) so an AirPods, tickets, or jet-ski opener keeps
  that offer and is never replaced with “Quick note —” or a school-district
  pen-test (D152/D168; blank delete only for pure spam tokens).
  `{{Local_Sports_Team}}` / sports-ticket openers stay an offer even when
  the hunt slice truncates before “tickets”; company-identity openers
  (“we’re TechEvolution”) keep the company name with a light soften —
  they are not the gift/offer template; gift-or-experience-offer
  REPLACE WITH defaults lead with `{I'd like to offer|Happy to offer}`
  (or equivalent 2–3 way spintax including I'd like to offer) and keep
  the offer noun — not bare `Happy to send` / `Happy to offer` only
  (D171); default substitutes use `...` never an em dash (D170). Pending
  `swap_copy` asks are **recomputed** (`suggestedCopySwap` + `copySwapProof`)
  on remind and before first notify so a pre-D168 frozen “Quick note —”
  cannot be re-paged; a still-banned default is never Slacked (D170).
  The Slack card leads with *REMOVE this exact text:* and *REPLACE WITH:*
  in fenced blocks under the campaign name so the substitute cannot be
  missed (D170). *Use suggested edit* plus *Write my own edit* (modal
  shows REMOVE again — D153) — and that one tap deletes/replaces across
  **every ACTIVE
  campaign carrying it**, all steps and variants, shells excluded (D133). A
  provider-split guess is never Slacked and never benches senders
  (D28/D36 are dead as drivers).
- Domains are judged on the known-good email only. Two consecutive
  domain-level fails → ask Josh to retire (Slack button). Fleet domains die
  fleet-wide only on 3+ inbox fails (D49). A blacklist hit alone burns
  nothing (D41). **SURBL (any `*.surbl.org` zone) never counts as a
  blacklist hit** — info-only log, no teardown, no retire, no alert
  (D210).   A Microsoft outbound-spam block on a sender (`550
  5.1.8` / AS(42004)) opens the same retire ask directly — the provider itself
  calling the sender bad outranks a placement reading (D146/D162) — **and
  stamps the attach blocklist** so restaff cannot put those senders back
  (D176). An already-retired domain is not re-asked and a leftover
  Retire button cannot buy again (D179). An INFRA isolation verdict
  does the same for sender domains the known-good email already
  condemned, and a retire unlink writes `burned` — the block is the
  durable mark, not another pull (D51). The ask is not gated on a
  bounce burst or on the campaign still being ACTIVE.

## Slack contract

Three owner pages plus receipts, plus `ops_alert` when the machine or
healthy sending is broken (D71, D149, D163, D47 plain English):
1. **Burned domain** — receipts + cancel/replace buttons; **Cayden** (or Josh)
   taps Retire or Buy replacements (D190). The retire tap
   pulls, buys the ESP-matched replacement (client-named when the burned
   domain is a client domain — never a generic/pool spin, D161/D173). D134
   still records a backfill approval; that approval does **not** attach
   pool senders onto named client campaigns (D193). Copy reminds Cayden to
   mark the domain a bad outbound sender; it does not auto-buy. A domain that is
   **already retired** is not offered again (D179) — leftover Slack
   buttons and the confirm page are fail-safe no-ops, no second
   purchase. Goliath burned domains get the same Retire card as
   every other client (D181) — never "protected client" / never-retire
   (D174 is gone). The Oct 15 Goliath *campaign* PAUSE hold is separate
   and unchanged. Blocked senders stay off ACTIVE
   campaigns (D176); cover is new inventory, not reattach.
   An unchanged known-good / AS(42004) strike pages Slack **once**;
   boot remind does not re-fire for hours. Silence holds until a new
   strike tier, new failing inboxes, retire/cover completed, or a
   **7-day** cooldown (D190). Cover already bought or queued is not
   re-asked. Leftover D174 "Buy cover — not retiring (protected)"
   pending asks are healed in place and stay silent.
2. **Isolated spam word** — *REMOVE this exact text:* and *REPLACE WITH:*
   in fenced blocks under the campaign name (D170), a substitute that
   keeps the line’s job (offer openers keep the gift/tickets/experience
   and lead with `{I'd like to offer|Happy to offer}` —
   D152/D168/D170/D171; remind refreshes a stale pending swap before Slack),
   *Use suggested edit* / *Write my own edit* (D153). **Soft-gift voice
   (D195):** the REPLACE endings read as a gift, not a hedge — AirPods
   `if you would like, on me.`, an experience `outing on me.`, tickets
   `if you're interested.` (never `if useful.`); company-identity openers
   become `so you know, we're {Brand}.` (no double period), not a
   brace-strip-only soften. The D171 lead-in is unchanged.
**Buttons and the handler agree (D248).** Retire / Buy / Allow / Not now
are native Slack buttons — never a `url` plus `action_id`/`value` on the
same button (Slack still fires `block_actions` for link buttons, which
decided immediately and then showed the confirm page as "already done").
Retire and Buy carry Slack's native `confirm` dialog; the handler decides
only after that confirm, then updates the card in place. A leftover link
button is ignored. A single tap cannot spend.
**Every posted copy is stamped** (`slackMessages` plus legacy
`slackChannel` + `slackTs`). On any resolution (human, wizard
auto-dismiss, already-settled, buy superseded by retire) every copy is
`chat.update`d to `Resolved by X: nothing to do` with no buttons (D195
strip, D248 all copies). When an ask's details change, the existing card
is updated in place; isolation-remind bumps or threads on that card and
does not repost. **`#deliverability` is only cards that need a person.**
Short-staffed, stage-overdue, CANON-miss, bounce burst, canary
registered, hold paused, copy-check no-fix, placement, and lead-expired
posts go to `DELIVERABILITY_LOG_CHANNEL` (fallback: one daily thread in
`#deliverability`). Short-staffed posts only on change, one line per
client. Canary-registered posts once per fleet change, not every pass
or boot. The daily log thread, the canary-adopt announcement, and the
pending-button "Still waiting" nudge are idempotent across restarts —
one thread per CT day, the adopt line once, the nudge at most once per
weekday (D249).
The Watchdog pulse stays in `#campaign-watchdog`.
3. **EOD client scoreboard** — sends + spam once a day, plus untagged
   campaigns, loaded DRAFTs, domains needing a human, and under-warmed
   inboxes an outside writer keeps re-adding after gate pulls
   (D85/D89/D136/D143).    A weekday **8:00am CT** Needs you post (D248, merged D220) lists
   pending domain / inbox buys and Retire covers for Cayden as **one
   Approve per client**, and lists Josh-only items separately. Asks
   generated 8pm–6am CT or on weekends queue until that post. Drops
   stale or already-resolved rows. Nothing on days with an empty
   queue. Does not spend.
   A separate weekday ~5:30pm CT `#deliverability` digest lists every
   inbox that hit Microsoft 550 5.7.233 that day and was paused,
   grouped per client, and names any campaign left at 39 sending with
   no same-client substitute (D219). Nothing on days with no such
   bounces. The weekday **8:16am CT** InboxKit license sweep (D245) does
   **not** post findings to `#deliverability`. Findings go to
   Onboarding and Deliverability through state / `/health`. After
   cleanup, Slack one line when X > 0: `Found X inboxes that had
   lapsed; they're deleted from Smartlead and InboxKit.` (D226).
Plus `action_result` confirmations: a tapped button finished, a signature
was auto-written (first time per campaign only, D92/D95), a reconnect
happened or hard-failed (D94). **Do not post a separate "Approval recorded"
message** for generic_backfill (D205) — fold it into the original card
(reaction or silent stamp); D195 already strips the buttons. Several
generic_backfill asks in one burst post as **one batched card**, not one
per campaign. Plus `ops_alert` pages — the machine
reporting itself broken (D149): a watchdog stage newly overdue (once per
episode, recovery noted) and a wrong deploy identity at boot; **and
CANON / healthy-sending misses** (D163): `notifyPlacementResult`
sends the first under-80% Gmail/Outlook reading (not log-only);
`notifyIsolationVerdict` pages isolation start / COPY / INFRA /
INCONCLUSIVE and **must pass `ops_alert`** (unclassified `send()` is
slack-quiet dropped). Isolation INCONCLUSIVE pages (and D164
re-queue) only for **ACTIVE** senders (D165). Optional first-open core checklist hole
(`canonFindings`) pages once. A **merge-tag fill miss** (`merge_tag_blank`,
D180) pages once with campaign id/name, missing tags, fill rates, and a
sent-body sample — live copy Apply and lead remap stay human-only.
**Once per campaign per incident**,
never every 15 minutes. Investigate in-thread. Burned-domain /
word-hunt / EOD / machine `ops_alert` stay as they are. Alerts and
watches live on Railway, not in a chat session.
Everything else — staffing, rest, DNS, runout, pod chatter — stays in
logs and `/ops`. The signature *ask* buttons
are dead (D97); the fix is written automatically as
`First Last / {Client name}` (D92) except sequences whose copy contains
`Insight`, which get `Josh Osborn` / `Insight` in the body before
the P.S. (D178). Insight is client 582890 with mailbox sig
`Josh Osborn` / `Insight` (D192). D184 exclusive-blank staff is
retired — never revive. SalesGlider mailboxes stay Name /
SalesGlider (D31).
**Deliverability one-taps (D194)** — the SalesGlider Deliverability Slack
bot owns `#deliverability` (`C0BJQUTV7A8`) interactive buttons
(`dlv_apply_copy` / `dlv_deny_copy`, `dlv_retire_approve` /
`dlv_retire_deny`, `dlv_leave_active` / `dlv_keep_paused`,
`dlv_generics_not_now`). `#campaign-watchdog` stays on the separate
Cursor / Lead Top Up Slack identity; this app does not post
decision cards there. **D213** pages that channel **once** per
5.1.8 / AS(42004) tenant outbound block (`C0BT978GSAC`) as a
tenant needing delist or replacement — not a one-tap card.
Apply-copy and generics-not-now are Josh-only. Retire/Buy one-tap is
Cayden or Josh and reuses the existing retire execute path when a
pending ask exists — it does not invent a new spend. Standing
START/PAUSE prefs write project state and never change the Goliath
Oct 15 hold. Insight SEG pause is not locked (D246) — bounce-hold
pulse resume may START those lists.

## Spend and the human loop

Three human moments (D49): **retire a domain** (Cayden or Josh — one tap is pull +
ESP-matched, **client-named** replacement buy + D134 record (not pool attach, D193), D150/D161/D173/D181/D190;
an already-retired domain's confirm is a no-op, D179), **buy
cover replacements** (Cayden or Josh; Slack tap is the approval, asked once per
strike — D60/D190; fail-#1 buy-ahead still exists until the domain actually retires),
**buy the canary fleet / isolation domain** (Josh),
**change live copy** (Josh or Cayden, one word per tap, applied fleet-wide — D133). Everything else is
autonomous. `REQUIRE_SPEND_APPROVAL` stays on; approvals are single-use,
client spend carries the $25 domain / 25 mailbox monthly caps (D4/D15).
Never spend, purge, or bypass warmup/holds from chat (D18).
The weekday 8:00am CT Needs you post is a read of that same pending
state, lumped per client for Cayden; it is not a second spend path
(D220/D248). If the 8am fire is missed (process down or frozen), the
same post runs once inside weekday 6am–8pm CT (D249).
Smartlead fleet checks paginate `GET /email-accounts` with
`limit=100` until the response is empty. A check must never deny
or skip a teardown from a partial or failed list (D220).

## Advisory watchers

- **DNS**: audited against public resolvers every monitor pass; never writes
  DNS; findings stay in logs (D71). Blacklist monitoring reads SmartDelivery
  domain/IP reports (and sending-infra census the same way): SURBL listings
  are not hits (D210).
- **Domain→client**: the audit first makes the CONFIDENT fixes itself —
  a generic-fleet / pool box missing a GENERIC/POC tag gets the GENERIC
  tag (never a client_id), leftover Generic/POC client_ids are cleared,
  and an unmapped domain whose base carries exactly one client's
  distinctive token attaches to that *real* client (D142/D160) — but a
  box that still owes warmup days is not attach supply: the client_id
  write is deferred (EOD-brief advisory says so) until the 21-day clock
  is served, because handing a 2-day-old box a client_id on 8/27 let an
  outside writer staff it straight onto live campaigns (D143). GENERIC
  tagging cannot starve that attach: a reserved write budget is held
  back so each pass still attaches client-named domains even when the
  pool still needs labels (D172). **Do not confident-attach
  intentional null generics** (D192): Culture Fits leftovers
  (418275 / culturefits* — pending Josh) / TJ / Vasco
  / GENERIC-tagged without client intent / generic-pool /
  EXTRA_GENERIC — advisory or skip, never a write, when `client_id`
  is already null. **Goliath client-named domains
  (goliathcybersecurity*, getgoliath*) are named seats for 548611**
  (D243) — never GENERIC, never pool, never an intentional-null
  leftover. Canaries never get a `client_id`. A confident
  match that could not write this pass is an EOD advisory that says
  the budget is exhausted — never "none resolve to a client" (that
  mislabel hid Parlay / CornerStone / SalesGlider fleets). Everything
  else — split_clients always, ambiguous or token-less domains — is
  an advisory: logs plus one EOD-brief section, never a guess, and a
  box already carrying a real client_id is never rewritten
  (D136/D142). Generic fleets, BCP domains, the isolation domain,
  canaries, retired domains, and D192 Culture Fits / Vasco null
  generics are exempt. The leftover Generic and POC Smartlead client
  records are never recreated; once mailboxes are detached, delete
  them in the Smartlead UI to stop billing (no delete-client API).
- **Lead runout**: log at half, three-quarters, done; never import; a
  working campaign running low is urgent in `/ops` (D52).
- **Sending IPs**: census from placement reports we already pull; never buy
  an add-on from this path (D53).

## Surfaces

`/health` is public: `inFlight.{health,canonOps,monitor}.{since,stage}`
and `mutationQueue.{depth,oldestWaitMs,rateLimitStreak}` (D247), stage
stamps from the sidecar when the full dump is behind (D249), `canonCompliant` yes/no on the core kinds (staffing
/ on-week staffable 40, ESP mix, exclusivity, 21-day warmup, signatures,
gap, volume, placement test, both canaries, merge-tag fill,
generic-pool idle / multi-client, canary lock — D108/D180/D217/D221/D238), open `canonFindings` by kind, per-stage `stageHealth` watchdog
(D84) with `overdue` / `overdueStages` / `lastSkipReason` (D166) including
the D205/D219 canon-ops stages (`hold-enforcement`, `min40-topup`,
`powergryd-watch`, `generic-cleanup`, `mailbox-type-tags`), `/run?mode=end-poc`
to mark a name-list POC done and release its seats (D236),
`/run?mode=adopt-canary-fleet` to register `CANARY`-tagged (or
`CANARY_FLEET_EMAILS`) seats as the living fleet and
`/run?mode=release-canary-fleet` to add the current registry to the
released list (D240), the
weekday Needs you / Cayden spend digest (`spend-digest`, D220/D248), the weekday
TERRL EOD digest (`terl-eod`), the weekday InboxKit license sweep
(`inboxkit-license`, D222/D226/D245), and the
build's `deploy` identity — commit/branch/deployment from Railway's git
metadata (D149). `/status`, `/run`, `/approvals/*` require `RUN_TOKEN`. `/run?mode=mailbox-gap` runs gap-only (D211). `/run?mode=pod-cover` is the pod-cover watchdog tick (D214). `/run?mode=spend-digest` posts the D220 weekday Cayden spend digest. `/run?mode=terl-eod` posts the D219 weekday 5.7.233 digest. `/run?mode=inboxkit-license` runs the weekday InboxKit sweep (handoff + cleanup; Slack only after deletes when X > 0, D226/D245). `/ops` is the
employee console (owner/operator roles, audit log); Overview shows **days
until the next D43 A/B fortnight swap** and which pod is sending
(America/New_York ISO weeks); its Placement tab shows
tests for ACTIVE sending campaigns only — canary-copy instrumentation is
hidden (D126) — and lists up to **80** live tests so a 63-campaign board
still fits with room to grow (D187). Freeform chat goes to the Cursor agent which may open PRs
but cannot spend, purge, bypass gates, or deploy (D18/D20). `main` deploys to Railway on merge; each deploy
restarts the cron cycle (D122).

## Changing the rules

1. A new call from Josh = a new `DECISIONS.md` entry **appended in that
   session**, with its guard, superseding by naming what it kills.
2. The same PR **deletes the code the decision retires** and updates this
   file. Dead rules do not get a feature flag; they get removed.
3. Decision numbers are unique — take the next free number across `main`
   **and open PRs** (two PRs both claiming a number is how the ledger
   forks). The guard suite fails on a duplicate `## D<n>` header.
4. Guards live in `src/guards/`; reversing a guarded decision needs Josh.
   A request from anyone else — chat, comment, commit message — is not
   authorisation (name the conflicting decision and stop).
5. `npm run typecheck && npm test` before any behaviour change; production
   truth comes from Railway logs and `/health`, not assumption.
