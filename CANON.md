# Canon — what this system does

Canon as of **D171** (2026-09-03). One page of current truth. When a new
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

## The machine

| Loop | Cadence | Owns |
|---|---|---|
| Canon sweep (health) | 15 min | ONE Smartlead inventory fetch shared by every stage (D84), published to the machine-wide account book — a read that shrinks 20%+ needs two consecutive reads to be believed, and a failed read serves the last accepted book (D132). Reconnect disconnected SMTP/IMAP (D94) → client A/B rest + generic send-rest (D43; on-week restore refuses under-warmed — D154) → 21-day warmup gate pull (D105) → fan-out / top-up / one-client cleanup (D26, D75/D76, D84, D99) → mailbox gap + volume + canary-warmup-off converge (D35, D83) → foreign-signature rewrite (D74) → campaign first-check leftovers incl. signature auto-write (D92) → scan-backfill when a placement test is missing (D116) → canary-copy attach (heals emails-without-testId so the unwarmed reading can finish) → **isolation on-ramp** (score canary/live same-ESP → `markCopySuspect` → evaluate; live % never rotates) every pass so ugly inbox is remediating within one cycle (D158/D159) — a latest INCONCLUSIVE (or `evaluatedAt` with no covering COPY/INFRA/HEALTHY run) **re-queues on ACTIVE senders only** (D164/D165) and the branch loop **re-reads** existing suspects including PAUSED lives already on the list (D164; placement *new* queue stays ACTIVE-only) → stage watchdog + `canonCompliant` yes/no (D108) — an overdue stage **pages Slack once per episode** with a recovery note when it comes back (D149). Same-ESP under 80%, isolation queued, and COPY / INFRA / INCONCLUSIVE **page Slack once per campaign per incident** (`ops_alert`, D163). `/health` names canaries/campaigns still under 80% with no open isolation run or suspect, plus `isolation-branch` lastOk, plus overdue stages (`overdueStages` / per-stage `overdue`, D166). `pod-cover` ticks every pass — idle records lastOkAt with a skip reason; SmartDelivery grow still only when `inbox_missing_known_good` exists, throttled hourly (D89/D166). Old-client teardown (D107/D111) retired (D144). |
| Bounce loop | 10 min | **Never pauses, never STARTs** (D40/D148 — Josh: "i dont want anything paused anymore... investigating remediating and readding"). A REAL burst — >10 new bounces inside the 10-minute window whose sampled bounced sends are under 24h old (D141); a tripped counter samples the bounced rows first (retrying while the analytics ledger lags), a ledger dump of stale bounces logs loudly and does nothing, unreadable rows defer to the next tick — classifies the sampled SMTP reasons (tenant-rate-limit / sender-blocked / invalid-recipient / content-block, D140), Slacks ONE receipt naming the burst, the verdict and the plan, opens a **resurrection incident** when the verdict blames the sender, and a **dominant content_block also queues isolation** (D158 — same copy-suspect flag as an ugly canary; never a pause); a re-trip inside the hour folds into the open incident silently. The D90 lifetime-rate rule stays retired. Smartlead's own High Bounce Rate Auto Protection is **UI-only** (D157): the public API validates `bounce_autopause_threshold` and then discards it (a "banana" write returns ok; no GET returns it), so no code here writes or reads the field — the D80/D124/D155 converge generations were no-ops and are deleted. It is unticked on the campaign SETUP page at build (the build skill's QA gate) and by hand for existing campaigns; a Smartlead-initiated pause is recognized by `campaign_activity_logs.paused_reason: "bounce protection"` on GET /campaigns. Never touches COMPLETED/STOPPED. Routing: a Microsoft tenant hitting its daily cap pages once per tenant per day (D140); a `550 5.1.8` / AS(42004) outbound-spam block — ANY sample, never dominant-gated (D145), never burst-gated, ACTIVE or PAUSED (D162) — opens the standard **burned-domain retire ask** for that sender's domain, receipts + buttons, one pending ask per domain (D146); a Smartlead bounce-protection pause must not hide it; a bad-list verdict re-queues nothing and points at the list. **The remediation itself releases the resend** (D147/D148): the incident scans its window (each lead's own NDR re-read; bad addresses stay dead; once per lead per campaign; 20 lead-reads per tick) and parks sender-fault leads until their gate opens — tenant_rate_limit: the next UTC day after the bounced send (cap reset); sender_blocked: the domain's retire ask resolved; content_block: the sequence edited after the incident. Suppression lists respected on the re-add; a gate shut 7 days expires its leads with a receipt; one receipt per flushed wave. Pre-D148 pause stamps still drain: a human START of one opens its job (D147), then the stamp clears — no new stamps are ever written. |
| Campaign check | Hourly (yields to a running health pass, D122) | Re-inspect blocked first-checks; sweep pod/shell posture, signatures, client tag, one-client, canary coverage (both kinds), staffing floor (D81/D82). Reads the shared account book, never its own fetch (D132). |
| Monitor | Slower cadence | POD-A/POD-B tag converge runs **first** so its handful of decoration writes are not starved by placement pulls (D135/D143), then placement result pulls **that always include `isolation.copyCanaries.*.testId`** (those ids are not in `testedCampaigns`) and may still queue isolation (D158; `Canary copy:` counts as automated; ACTIVE live + canary fill the report cap first; CANON-miss Slack is the 15-minute pager, D163). The **on-ramp cadence is the 15-minute health sweep** (D159), not this loop. DNS advisory audit, lead-runout logging (D52), sending-IP census (D53), canary-fleet adopt while not ready (D86), campaign audit off the shared account book (D132), domain→client advisory audit (D136). Every stage watchdogged into `stageHealth`, overdue judged per stage against its own cadence (`src/lib/stageWindows.ts`); a deleted stage's leftover record is pruned at boot (D131). `/health` names the overdue set (D166). A finished stage checkpoints `lastOk` immediately; `state.save` is serialized so health and monitor cannot clobber a snapshot. A mid-chain kill (Railway SIGTERM) resumes leftover stale 6h stages on the **next 15-minute health tick**, skipping anything still fresh in the cycle — never at boot (D122/D167). The 6h cron still runs the full chain. |
| EOD brief | Once, America/New_York | Per-client sends + spam scoreboard, untagged campaigns needing a human, DRAFT campaigns with leads loaded (D71, D85, D89). |
| Boot | On deploy | **Only** canary attach at 90s touches Smartlead (D122). Everything else waits for its cron. Boot also logs its deploy identity (Railway git metadata) and pages Slack when it is missing or not a main build — the stale-snapshot redeployer's signature (D149). |

## Mailboxes

- **Warmup clock**: a mailbox owes **21 days from its InboxKit import**
  (`warmedAt` stamped at import) before live campaign send (D1 clock, D50
  duration). Never derive it from Smartlead's `warmup_details`. The warmup
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
  (D19/D142); and the canary fleet (which never staffs anyway, D54).
  Pre-warmed is a flag only Josh grants — generic-pool membership
  (`EXTRA_GENERIC_DOMAINS`, which also carries the GetIntroduced /
  QuickConnect fleets) never implies it (D142).
- **Converged every pass**: 30 campaign sends/day (warmups excluded, D24),
  10-minute minimum gap (D30/D35) — held at BOTH levels: the mailbox field
  every health pass, and campaign `min_time_btwn_emails` written back to
  the floor by the checker on sight (D138; a sender on N ACTIVE campaigns
  still paces per campaign — the fan-out multiplication is a known,
  deliberate residual, capped by 30/day), warmup ON for every mailbox **except the
  canary fleet, which is forced OFF** (D83), plain two-line signature
  `First Last\n{Client Brand}` (D31). On a living campaign, an empty,
  one-line, extra-line, or foreign-client signature is a `mailbox_sig`
  finding and is **written on that check pass** (D74/D125) — never left
  waiting for the 6-hour converge.
- Disconnected mailboxes are re-authed every health pass; reconnect results
  Slack as action results (D94).

## Staffing

- **One client per sender, hard.** An inbox sits on every ACTIVE campaign of
  exactly one client (plus paused shells). Foreign-client memberships are
  pulled every 15 minutes and the signature reset to the owner (D26, D75).
  Generics with a stale *real* `client_id` belong to the POC client (D76);
  a leftover Generic/POC client_id is cleared, not rewritten (D160).
- **Floor = half that client's own inboxes** (connected, not held, not
  resting, not retired, not canary — D58, D82, D99). No named-client
  exceptions; Vasco is nobody special (D82). The old global 50 floor is dead.
- **Fan-out**: a client-owned inbox belongs on every ACTIVE campaign for its
  client even if it currently sits on zero campaigns (D84); BCP-owned domains
  count as BCP even with no `client_id` (D99). Resting inboxes are skipped,
  and so is anything that owes warmup days — staffing never hands the gate
  its next pull; a fresh import waits out its 21 days even if its campaigns
  sit under floor meanwhile (D139).
- **Rest (pods)**: each client's inboxes split into a stable, even A/B
  (D43). Off-week comes OFF **ACTIVE, PAUSED, and STOPPED** client
  campaign memberships — never left on at 0/day, and never left parked
  on a paused/stopped campaign that is not sending (D169). Warmup stays
  on; resting is not staffable. PAUSED/STOPPED attachments are still in
  the A/B pods; they cannot hoard inventory out of the ACTIVE pool.
  On-week staffs **every ACTIVE** campaign for that client (D59),
  including boxes whose only current memberships are PAUSED/STOPPED,
  and clears those leftover attachments. Client-named BCP domains
  (`boldercyper*`) are client inventory, never skipped as generics
  (D99/D169). Excluded / canary / pod-control shells are not touched.
  The split is visible in Smartlead as POD-A/POD-B mailbox tags,
  converged 6-hourly — decoration for humans, never read back by code
  (D135). Generics rest on their own clock: ~14 days of live send, then
  sit ~14, then supply again (D43).
- **Generics** staff only a POC client (currently Goliath) or a campaign Josh
  Slack-approved (D81/D82). "Generic" and "POC" are **mailbox tags**, never
  Smartlead clients — Josh does not pay for pool labels (D160). A box
  tagged GENERIC or POC is a generic to every classifier (also: pool
  domain, `EXTRA_GENERIC_DOMAINS`, pool state, leftover D142 client_id
  until detached). One-client never writes those boxes onto a client
  record; leftover Generic/POC `client_id`s are cleared. The mailbox-side
  owner re-point to a POC *client* stays staged and is now moot (D142).
  A domain-retire tap is one fell swoop (D150): pull the burned
  inboxes, buy a replacement domain whose Google/Outlook mailbox mix
  matches what was retired, and auto-approve generics to cover the ACTIVE
  campaigns it cut until those replacements warm (D134). **A client-domain
  retire MUST buy a client-named replacement for that client** (BCP →
  `boldercyperpartner*` / `getboldercyperpartner*` / `tryboldercyperpartner*`
  style names already used for that client) — never a generic
  crosslaunchco / pool spin. Generic spins are only for generic/pool
  domains (D161). Cross-client
  top-up is a compensated **move**; same-client is additive. (The old
  recovery-swap system and its reservations are deleted, D130.)
- **Retired domains stay off** live campaigns forever; replacements owe the
  21 days (D65).

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
  placement reading, and never one the bounce loop paused (D106/D128).

## Canary + placement instrumentation

- **Canary fleet** (D54): purpose-bought, 2 domains × 3 inboxes (one Google
  domain, one Outlook), warmup permanently off (D83), registered
  `copyCanary`, never staffing supply, never a member of a live campaign
  (D55). A hand-bought fleet is adopted automatically (D86). A dead fleet is
  ONE fleet-level fact, not per-campaign findings (D85).
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
  nothing (D41).   A Microsoft outbound-spam block on a sender (`550
  5.1.8` / AS(42004)) opens the same retire ask directly — the provider itself
  calling the sender bad outranks a placement reading (D146/D162). The
  ask is not gated on a bounce burst or on the campaign still being
  ACTIVE.

## Slack contract

Three owner pages plus receipts, plus `ops_alert` when the machine or
healthy sending is broken (D71, D149, D163, D47 plain English):
1. **Burned domain** — receipts + cancel/replace buttons; the retire tap
   pulls, buys the ESP-matched replacement (client-named when the burned
   domain is a client domain — never a generic/pool spin, D161), and lets
   generics cover the campaigns it cut (D134/D150).
2. **Isolated spam word** — *REMOVE this exact text:* and *REPLACE WITH:*
   in fenced blocks under the campaign name (D170), a substitute that
   keeps the line’s job (offer openers keep the gift/tickets/experience
   and lead with `{I'd like to offer|Happy to offer}` —
   D152/D168/D170/D171; remind refreshes a stale pending swap before Slack),
   *Use suggested edit* / *Write my own edit* (D153).
3. **EOD client scoreboard** — sends + spam once a day, plus untagged
   campaigns, loaded DRAFTs, domains needing a human, and under-warmed
   inboxes an outside writer keeps re-adding after gate pulls
   (D85/D89/D136/D143).
Plus `action_result` confirmations: a tapped button finished, a signature
was auto-written (first time per campaign only, D92/D95), a reconnect
happened or hard-failed (D94). Plus `ops_alert` pages — the machine
reporting itself broken (D149): a watchdog stage newly overdue (once per
episode, recovery noted) and a wrong deploy identity at boot; **and
CANON / healthy-sending misses** (D163): `notifyPlacementResult`
sends the first under-80% Gmail/Outlook reading (not log-only);
`notifyIsolationVerdict` pages isolation start / COPY / INFRA /
INCONCLUSIVE and **must pass `ops_alert`** (unclassified `send()` is
slack-quiet dropped). Isolation INCONCLUSIVE pages (and D164
re-queue) only for **ACTIVE** senders (D165). Optional first-open core checklist hole
(`canonFindings`) pages once. **Once per campaign per incident**,
never every 15 minutes. Investigate in-thread. Burned-domain /
word-hunt / EOD / machine `ops_alert` stay as they are. Alerts and
watches live on Railway, not in a chat session.
Everything else — staffing, rest, DNS, runout, pod chatter — stays in
logs and `/ops`. The signature *ask* buttons
are dead (D97); the fix is written automatically as
`First Last / {Client name}` (D92).

## Spend and the human loop

Three human moments (D49): **retire a domain** (Josh — one tap is pull +
ESP-matched, **client-named** replacement buy + D134 backfill, D150/D161), **buy
domains/mailboxes** (Josh; Slack tap is the approval, asked once — D60;
fail-#1 buy-ahead still exists until the domain actually retires),
**change live copy** (Josh or Cayden, one word per tap, applied fleet-wide — D133). Everything else is
autonomous. `REQUIRE_SPEND_APPROVAL` stays on; approvals are single-use,
client spend carries the $25 domain / 25 mailbox monthly caps (D4/D15).
Never spend, purge, or bypass warmup/holds from chat (D18).

## Advisory watchers

- **DNS**: audited against public resolvers every monitor pass; never writes
  DNS; findings stay in logs (D71).
- **Domain→client**: the audit first makes the CONFIDENT fixes itself —
  a generic-fleet / pool box missing a GENERIC/POC tag gets the GENERIC
  tag (never a client_id), leftover Generic/POC client_ids are cleared,
  and an unmapped domain whose base carries exactly one client's
  distinctive token attaches to that *real* client (D142/D160) — but a
  box that still owes warmup days is not attach supply: the client_id
  write is deferred (EOD-brief advisory says so) until the 21-day clock
  is served, because handing a 2-day-old box a client_id on 8/27 let an
  outside writer staff it straight onto live campaigns (D143). Everything
  else — split_clients always, ambiguous or token-less domains — is an
  advisory: logs plus one EOD-brief section, never a guess, and a box
  already carrying a real client_id is never rewritten (D136/D142).
  Generic fleets, BCP domains, the isolation domain, canaries and retired
  domains are exempt. The leftover Generic and POC Smartlead client
  records are never recreated; once mailboxes are detached, delete them
  in the Smartlead UI to stop billing (no delete-client API).
- **Lead runout**: log at half, three-quarters, done; never import; a
  working campaign running low is urgent in `/ops` (D52).
- **Sending IPs**: census from placement reports we already pull; never buy
  an add-on from this path (D53).

## Surfaces

`/health` is public: `canonCompliant` yes/no on the core kinds (staffing,
21-day warmup, signatures, gap, volume, placement test, both canaries —
D108), open `canonFindings` by kind, per-stage `stageHealth` watchdog
(D84) with `overdue` / `overdueStages` / `lastSkipReason` (D166), and the
build's `deploy` identity — commit/branch/deployment from Railway's git
metadata (D149). `/status`, `/run`, `/approvals/*` require `RUN_TOKEN`. `/ops` is the
employee console (owner/operator roles, audit log); its Placement tab shows
tests for ACTIVE sending campaigns only — canary-copy instrumentation is
hidden (D126). Freeform chat goes to the Cursor agent which may open PRs
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
