# Canon — what this system does

Canon as of **D145** (2026-08-27). One page of current truth. When a new
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
Slack speaks only when a human decision is needed or the day is done.

## The machine

| Loop | Cadence | Owns |
|---|---|---|
| Canon sweep (health) | 15 min | ONE Smartlead inventory fetch shared by every stage (D84), published to the machine-wide account book — a read that shrinks 20%+ needs two consecutive reads to be believed, and a failed read serves the last accepted book (D132). Reconnect disconnected SMTP/IMAP (D94) → client A/B rest + generic send-rest (D43) → 21-day warmup gate pull (D105) → fan-out / top-up / one-client cleanup (D26, D75/D76, D84, D99) → mailbox gap + volume + canary-warmup-off converge (D35, D83) → foreign-signature rewrite (D74) → campaign first-check leftovers incl. signature auto-write (D92) → scan-backfill when a placement test is missing (D116) → canary-copy attach → stage watchdog + `canonCompliant` yes/no (D108). Old-client teardown (D107/D111) retired (D144). |
| Bounce loop | 10 min | Pause an ACTIVE campaign only on a REAL burst: >10 new bounces inside the 10-minute window whose sampled bounced sends are under 24h old (D141). A tripped counter samples the bounced rows first (retrying while the analytics ledger lags); a ledger dump of stale bounces logs loudly and never pauses; unreadable rows defer to the next tick. The D90 lifetime-rate rule is retired — verified lists never bounce like that. Converge Smartlead `bounce_autopause_threshold` to 100 (off) on drift (D80/D84/D88; one forced full-fleet off-write ran under D124). Never touches COMPLETED/STOPPED; a bounce pause is stamped so qa-unpause never fights it, and is not a pendingResume (D40/D128). A real pause classifies the sampled SMTP reasons — tenant-rate-limit / sender-blocked / invalid-recipient / content-block. A Microsoft tenant hitting its daily cap Slacks once per tenant per day (D140); a `550 5.1.8` outbound-spam block on a mailbox pages on ANY sample — never dominant-gated — once per sender per day, because it does not reset at midnight and repeated blocks burn the domain (D145); everything else stays in logs. |
| Campaign check | Hourly (yields to a running health pass, D122) | Re-inspect blocked first-checks; sweep pod/shell posture, signatures, client tag, one-client, canary coverage (both kinds), staffing floor (D81/D82). Reads the shared account book, never its own fetch (D132). |
| Monitor | Slower cadence | POD-A/POD-B tag converge runs **first** so its handful of decoration writes are not starved by placement pulls (D135/D143), then placement result pulls, DNS advisory audit, lead-runout logging (D52), sending-IP census (D53), canary-fleet adopt while not ready (D86), campaign audit off the shared account book (D132), domain→client advisory audit (D136). Every stage watchdogged into `stageHealth`, overdue judged per stage against its own cadence (`src/lib/stageWindows.ts`); a deleted stage's leftover record is pruned at boot (D131). |
| EOD brief | Once, America/New_York | Per-client sends + spam scoreboard, untagged campaigns needing a human, DRAFT campaigns with leads loaded (D71, D85, D89). |
| Boot | On deploy | **Only** canary attach at 90s touches Smartlead (D122). Everything else waits for its cron. |

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
  Generics with a stale `client_id` belong to the POC client (D76).
- **Floor = half that client's own inboxes** (connected, not held, not
  resting, not retired, not canary — D58, D82, D99). No named-client
  exceptions; Vasco is nobody special (D82). The old global 50 floor is dead.
- **Fan-out**: a client-owned inbox belongs on every ACTIVE campaign for its
  client even if it currently sits on zero campaigns (D84); BCP-owned domains
  count as BCP even with no `client_id` (D99). Resting inboxes are skipped,
  and so is anything that owes warmup days — staffing never hands the gate
  its next pull; a fresh import waits out its 21 days even if its campaigns
  sit under floor meanwhile (D139).
- **Rest (pods)**: each client's inboxes split into a stable, even A/B. The
  off-week half comes OFF live campaigns (never left on at 0/day); warmup
  stays on; resting is not staffable (D43). The split is visible in
  Smartlead as POD-A/POD-B mailbox tags, converged 6-hourly — decoration
  for humans, never read back by code (D135). Generics rest on their own clock:
  ~14 days of live send, then sit ~14, then supply again (D43).
- **Generics** staff only a POC client (currently Goliath) or a campaign Josh
  Slack-approved (D81/D82). "Generic" and "POC" exist as Smartlead client
  records used purely as mailbox pools: a box assigned to either is a
  generic to every classifier, and one-client never rewrites that
  assignment; the mailbox-side owner re-point to POC is staged, not live
  (D142); a domain-retire tap auto-approves the ACTIVE
  campaigns it pulled senders from, so volume never drops while the
  replacements warm (D134). Cross-client top-up is a compensated **move**;
  same-client is additive. (The old recovery-swap system and its
  reservations are deleted, D130.)
- **Retired domains stay off** live campaigns forever; replacements owe the
  21 days (D65).

## Pulls and pauses

- **Kill-only** (D51): placement %, bounce %, blacklists, and leftover
  HOLD-UNTIL tags do NOT pull a mailbox off an ACTIVE campaign (D128). The
  only removals are Josh killing a mailbox / retiring its domain, and the
  21-day warmup gate (D105). Health backfills to the floor afterwards.
- 80% same-ESP live / 85% launch (promo tab = miss) are **readings** — the
  launch bar blocks QA-unpause of a new campaign (D46/D106), the live number
  is a log. Never rotate on any of it; never use the blended all-ESP score
  for anything (D32).
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

- A campaign in spam is a flag, not a verdict (D49). Read three things on the
  same domains: the campaign-copy test per ESP, the known-good control per
  ESP, and the unwarmed canary fleet sending that same copy (D93, D96).
  - Known-good also failing an ESP → **infra**, not a word.
  - Unwarmed canaries land the copy while live senders fail → infra.
  - Campaign copy fails an ESP, known-good fine everywhere, unwarmed canaries
    also fail that copy → **word hunt** (deletion tests on the isolation rig).
    An unarmed rig asks Josh once to buy its isolation domain — the tap is
    the approval, the buy is spend-gated, and the bought domain arms the
    rig from state (`ISOLATION_DOMAIN` still overrides) (D137).
  - No unwarmed reading yet → wait. Do not hunt.
- The hunt runs autonomously; Slack fires **once** when it has the word:
  receipts, the suggested edit, one *Make the changes* button (D69) — and
  that one tap deletes/replaces the word across **every ACTIVE campaign
  carrying it**, all steps and variants, shells excluded (D133). A
  provider-split guess is never Slacked and never benches senders (D28/D36
  are dead as drivers).
- Domains are judged on the known-good email only. Two consecutive
  domain-level fails → ask Josh to retire (Slack button). Fleet domains die
  fleet-wide only on 3+ inbox fails (D49). A blacklist hit alone burns
  nothing (D41).

## Slack contract

Exactly three pages plus receipts (D71, D47 plain English):
1. **Burned domain** — receipts + cancel/replace buttons; the retire tap
   also lets generics cover the campaigns it cut (D134).
2. **Isolated spam word** — the word, the edit, *Make the changes*.
3. **EOD client scoreboard** — sends + spam once a day, plus untagged
   campaigns, loaded DRAFTs, domains needing a human, and under-warmed
   inboxes an outside writer keeps re-adding after gate pulls
   (D85/D89/D136/D143).
Plus `action_result` confirmations: a tapped button finished, a signature
was auto-written (first time per campaign only, D92/D95), a reconnect
happened or hard-failed (D94). Everything else — staffing, rest, DNS,
runout, pod chatter — stays in logs and `/ops`. The signature *ask* buttons
are dead (D97); the fix is written automatically as
`First Last / {Client name}` (D92).

## Spend and the human loop

Three human moments (D49): **retire a domain** (Josh), **buy
domains/mailboxes** (Josh; Slack tap is the approval, asked once — D60),
**change live copy** (Josh or Cayden, one word per tap, applied fleet-wide — D133). Everything else is
autonomous. `REQUIRE_SPEND_APPROVAL` stays on; approvals are single-use,
client spend carries the $25 domain / 25 mailbox monthly caps (D4/D15).
Never spend, purge, or bypass warmup/holds from chat (D18).

## Advisory watchers

- **DNS**: audited against public resolvers every monitor pass; never writes
  DNS; findings stay in logs (D71).
- **Domain→client**: the audit first makes the CONFIDENT fixes itself —
  a generic-fleet box with no client_id joins the Generic marker, and an
  unmapped domain whose base carries exactly one client's distinctive
  token attaches to that client (D142) — but a box that still owes warmup
  days is not attach supply: the client_id write is deferred (EOD-brief
  advisory says so) until the 21-day clock is served, because handing a
  2-day-old box a client_id on 8/27 let an outside writer staff it
  straight onto live campaigns (D143). Everything else — split_clients
  always, ambiguous or token-less domains — is an advisory: logs plus one
  EOD-brief section, never a guess, and a box already carrying a real
  client_id is never rewritten (D136/D142). Generic fleets, BCP domains,
  the isolation domain, canaries and retired domains are exempt.
- **Lead runout**: log at half, three-quarters, done; never import; a
  working campaign running low is urgent in `/ops` (D52).
- **Sending IPs**: census from placement reports we already pull; never buy
  an add-on from this path (D53).

## Surfaces

`/health` is public: `canonCompliant` yes/no on the core kinds (staffing,
21-day warmup, signatures, gap, volume, placement test, both canaries —
D108), open `canonFindings` by kind, per-stage `stageHealth` watchdog
(D84). `/status`, `/run`, `/approvals/*` require `RUN_TOKEN`. `/ops` is the
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
