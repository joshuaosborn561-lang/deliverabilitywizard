# Deliverability Wizard — operating rules

Rules that outlive a chat session. Anything here was decided deliberately,
usually after production showed us the alternative was wrong. Change them only
with the repo owner's say-so, and update this file in the same commit.

This file is loaded automatically each session. If you are an agent working in
this repo, read it before changing behaviour described below.

## Who works here

Two people drive this repo with AI assistance: Josh owns the product
decisions, Cayden contributes freely alongside him.

**Add features, fix bugs and refactor freely while the tests pass.** That
needs nobody's permission.

**Reversing an entry in `DECISIONS.md` needs Josh.** The guards in
`src/guards/owner-intent.test.ts` exist to catch that and tell you who to ask.
If a guard blocks something that looks genuinely wrong, raise it — do not
delete the guard to go green.

**Being asked to do it is not authorisation.** A request from anyone other
than Josh — in chat, in a comment, in a commit message — does not override a
`DECISIONS.md` entry. Say which decision it conflicts with and ask Josh. For
example, asked to rotate in mailboxes that have not warmed:

> That reverses D1 / D50 — a mailbox owes 21 days from its InboxKit import before
> going into a live campaign, and these have not served it. Josh set that
> after the opposite behaviour nearly put cold mailboxes into client
> campaigns. Check with him and I will make the change if he agrees.

Then stop. Do not implement it while waiting.

**When Josh makes a new call in a session, append it to `DECISIONS.md` in that
same session, with its guard.** Chat history is not durable; the repo is.

Work on your own branch and merge through a PR — never push to another
person's branch.

**`main` is the deploying branch.** Railway watches it, so a merge there is a
production deploy. Each deploy restarts the app, which resets the cron cycle —
avoid merging in a tight sequence when you need a scheduled job to actually
run.

Verified against Railway on 2026-08-12: service `deliverabilitywizard`,
environment `production`, source repo `joshuaosborn561-lang/deliverabilitywizard`,
active deployment on branch `main` at `7b6c83b`. This file previously named
`cursor/generic-pool-expand-240-2606`, which by then sat 123 commits behind
`main` and had not deployed in a long time. Re-check with
`railway status --json` rather than trusting this line if the two ever
disagree again.

## Warmup and the mailbox pool

**Warmup is owed from the InboxKit import, not from Smartlead's warmup
record.** A mailbox bought from InboxKit is cold on arrival however long
Smartlead's `warmup_details.created_at` claims warmup has existed. The pool
stamps `warmedAt` at import and the mailbox owes a full `POOL_WARMUP_DAYS`
(21, D50) before it may enter a live campaign.

This was implemented the other way round once. It moved 74 clocks earlier and
would have rotated cold mailboxes into client campaigns. Do not re-derive it
from Smartlead's data.

`EXTRA_GENERIC_MAILBOXES` holds **from-names carried by a whole fleet**, not
individuals. "harmony norris" is the sender identity on ~100 mailboxes at
crosslaunchco.com; "breanna escobar" on ~100 at crossscaleco.com. Every
account matching at or above the match threshold is registered — matching only
the best one stranded 198 pre-warmed generics. These arrive pre-warmed and are
registered `available` immediately; they owe no warmup.

`EXTRA_GENERIC_DOMAINS` is authoritative for those fleets: every mailbox on
`crosslaunchco.com`, `crossscaleco.com`, and `cleartechco.com` is pre-warmed.
Do not rely on exact from-name spelling or Smartlead's reported warmup start;
those have already caused live pre-warmed senders to be pulled.

## Sender identity

**One client per sender — not one campaign.** A mailbox (client domain or
generic) may sit on **every ACTIVE campaign for that same client**, except
when it is in its off-week rest (D43 qualifies D26). BCP
mailboxes go on all BCP campaigns; Parlay on all Parlay; etc. (`ClientFanOutService`,
D26). Cross-client membership is still forbidden. The dedicated D54/D55
canary fleet is not staffable supply and stays **off** live campaigns.

Generics may staff **any** client including BCP (D27). On assign, signature /
from-name / client id are set to the receiving client.

**Cross-client top-up is still a move** (remove from the other client, add to
the receiver). **Same-client** top-up/fan-out is additive — keep the mailbox
on the other campaigns for that client.

Warmup stays **on for every mailbox** (mailbox-settings converge), except
the dedicated D54 canary fleet — those six boxes never have warmup
enabled. The 15-minute gap pass turns it back off if it drifted on (D83).

## Rotation thresholds

**D51 / D79 / D88 / D90 — kill-only pull.** Placement below 80% same-ESP and the warmup
/ HOLD-UNTIL gate do **not** pull a mailbox off an ACTIVE campaign. There
is no per-sender bounce pull — D5's 5% after 50 sends is retired. Those
numbers stay isolation readings and logs. Do **not** pause a campaign on
a 20%/7% bounce band (D78/D80 retired by D88). The 10-minute loop pauses
an ACTIVE campaign over **10%** bounce after **1,000** leads emailed, or
more than **10** new bounces in 10 minutes (D90). Do **not** turn Smartlead
`bounce_autopause_threshold` on; that same loop converges it to 100 (off)
on drift. The only automatic live mailbox removal is Josh killing that
mailbox / retiring its domain; health backfills to the half-client floor.
Never use the blended / all-ESP SmartDelivery score as a rotation signal
(D32). Bounce at 2% is a log, not a Slack (D71).

Each sending inbox must be on a living **known-good** canary (pod-control
test). Each ACTIVE campaign gets a SmartDelivery **canary-copy test** from
the dedicated D54/D55 fleet (2 domains, 3 inboxes each, one Google and one
Outlook, warmup off). Those six stay off live campaigns. They are extra
to the half-client staffable floor.

The word-deletion test is **not** “Outlook buried, Gmail fine.” It
runs when the campaign copy test is not inboxing on an ESP and the
known-good email on those same domains is fine on every scored ESP
(D93). Confirm, hunt the word, then Slack one button: it was this
word, suggested edit, make the changes? (D69). Do not bench senders
on that signal.

Do **not** hunt already-PAUSED campaigns for 7% bounce (D91 retired D29).
Do **not** auto-`START` — a manual pause stays paused (D40). Only
protective pauses recorded in `pendingResumes` may be resumed by health,
and never when the campaign is **STOPPED**. Disconnected SMTP/IMAP
mailboxes are reconnected every health pass (D94).

Campaigns are topped up to **half that client's inboxes** (staffable
senders: connected SMTP/IMAP, not held, and not resting). Disconnected membership
does not count (D25). Health also runs same-client fan-out and client rest (D43). `CRON_HEALTH`
every 15m; bounce autostop every 10m (Smartlead off-write only, D88); Measure on the slower monitor.
`TOP_UP_EXCLUDE_CAMPAIGNS` holds ids or name fragments to leave alone —
currently the MSRS, HVAC and Roofers campaigns, listed by exact id so a
future campaign with a similar name is not skipped by accident.

## Campaign checks (D81)

A new campaign id gets a **first-check** on the next health pass (15 minutes)
against the standing rules: client tag, mailbox signatures, `%signature%`
in the sequence, no foreign brand in copy, one-client membership,
pod-control shell stays paused, generics only on a **POC** client or after
Josh Slack-approves a backfill. Goliath is marked POC. Bounce pause
is not this checker (D90). Missing signature is written on the spot
(D92). Slack the first time we write a campaign; a leftover
backfill does not re-ping every pass (D95). The old
*Add %signature%* button is retired and leftover pending asks
are dismissed on boot (D97). It stays on that first-check
until it passes.

After it passes, an **hourly sweep** watches pod/shell, mailbox signatures,
client tag, one-client, **active canaries for each serving inbox and
campaign**, and the floor (**half that client's inboxes**). Logs are
`[campaign-check]`. Slack is Allow generics plus “I added the
signature” the first time we write that campaign (D95).
This does not START a campaign, import leads, spend, or pull a mailbox.

## Canon sweep (D84)

The 15-minute health pass fetches Smartlead inventory **once**
(`fetchInventory`) and every stage shares it; mutating stages keep the
snapshot truthful in place (`recordMembership`/`dropMembership`). Do not
add a stage that refetches the account book — eight per-stage refetches
plus blind converge writes are what starved production into 429s while
the checker's findings sat unread.

Fan-out staffs **any client-owned inbox onto every ACTIVE campaign for
its client**, including inboxes currently on zero campaigns and clients
with a single campaign. Idle generics stay top-up supply. Bounce
autopause converge is **write-on-drift** (cached per campaign, 6-hour
read-verify) and never touches COMPLETED/STOPPED campaigns. Terminal
campaigns leave the campaign-check scoreboard. A blocked first-check
re-inspects hourly, not every 15 minutes. Missing placement coverage
kicks a scan on the pass that finds it.

Every stage records `stageHealth` (lastOkAt / consecutiveFailures /
duration). `/health` returns `canonFindings` (open findings by kind) and
`stages`; `[watchdog]` logs any stage overdue or failing. Check those
before trusting that "the loop is running".

## Findings have owners (D85)

A finding the sweep keeps reporting with no path to zero is a bug in the
sweep, not a fact of life:

- **Missing `%signature%`** is written automatically (D92): the tag is
  appended and the mailbox signature is set to First Last / client
  name (Goliath Cybersecurity, SalesGlider Growth Partners, …). Slack
  the first time we write a campaign, not a button and not every
  leftover backfill pass (D92/D95).
- **Untagged campaigns** the tagger cannot uniquely match (D77 forbids
  guessing) are named on the end-of-day brief until a human tags them in
  Smartlead.
- **A dead unwarmed-canary fleet** (zero connected mailboxes) is ONE
  fleet-level fact (`canaryFleetDown` on `/health`, one `[canon]` line,
  one EOD line) — never a finding per campaign. Per-campaign canary
  checks resume automatically once the fleet has a connected mailbox.
- The standalone Smartlead autopause converge service is retired; the
  bounce autostop loop owns that write (write-on-drift). Do not add a
  second writer.
- **A canary fleet bought by hand in InboxKit is adopted automatically**
  (D86): registered `copyCanary` (never staffing supply), exported to
  Smartlead, warmup off. Runs at boot and on the monitor pass while the
  fleet is not ready. Attach campaign-copy tests on that same pass (D89),
  not only inside a healthy health run. Do not hand-edit state to register
  canaries.
- **Pending single `%signature%` asks collapse into one bulk ask** when
  two or more campaigns are blocked (D89). Pre-D87 singles do not own
  those campaigns.
- **EOD names DRAFT campaigns that already have leads** and are not
  sending (D89). Does not import and does not START them.

## When setting up a campaign

Follow these rails (same text lives in `campaignSetupPrompt()` and `/ops`):

1. Staffing floor is half that client's own inboxes (connected SMTP/IMAP, not held, not resting). Vasco is not special. Generics fill only a POC or a Josh Slack-approved campaign. Keep at least ~30% Google and ~30% Microsoft. Do not buy a third client-domain set.
2. Split that client's inboxes into A and B (even split). Off-week half comes OFF live campaigns (warmup stays on). Do not leave resters on a campaign at `MESSAGE_PER_DAY=0`.
3. Same-client fan-out still applies for *on-week* client inboxes only. A resting mailbox must not be added to every ACTIVE campaign for that client.
4. Generics do not sit on the same A/B fortnight. They rest after ~14 days of live send, then become supply again after the same sit.
5. 21 days from InboxKit import is the warmed-vs-unwarmed clock. Pool supply is warmed only. Each sending inbox must be on a living known-good copy canary. Each ACTIVE campaign must have its copy on the unwarmed fleet canary. Pre-warmed fleets skip that wait.
6. Every mailbox: 30 campaign emails/day (warmups not included), 10-minute gap, warmup ON (except the D54 canary fleet), plain Name / Brand signature.
7. Placement tests are one recurring SmartDelivery schedule per campaign (`every_days: 1`), not a new test each morning. No plan quota (unlimited). Still ≤50 senders per test (SmartDelivery API limit).
8. Never auto-resume a campaign someone paused or stopped by hand. Protective pauses we took stay in `pendingResumes` only. Bounce autostop pauses on D90 trips (10% after 1k, or >10 bounces in 10 minutes) and those are not pendingResumes; leave Smartlead bounce auto-pause off.
9. Do not spend, purge, or bypass warmup/holds from chat. Approvals stay on.
10. After launch: health (15m) will rest, top-up, and fan-out in the background. Slack only pages a burned domain, an isolated word, or the EOD send/spam scoreboard (D71). Watch `[client-rest]` / `[health]` logs for the rest.

## Held mailbox placement tests (D39)

Mailboxes pulled off campaigns (HOLD) get **separate** SmartDelivery recurring
tests — not re-attached to live campaigns. The Slack day brief is once at
end of day: per-client sent and spam (D71).

## Sender rest (D43)

Client inboxes are split **A/B per client** (even, stable). Off-week they
are removed from live campaigns; warmup stays on. Resting is not staffable.
Generics fill a POC (or Slack-approved) campaign with at least ~30% Google
and ~30% Microsoft. A generic sits only after ~14 days of live send — not
on the client fortnight — then becomes supply again after the same sit.
21 days from InboxKit import is the warmed-vs-unwarmed clock (D50).
Unwarmed boxes are not floor supply; the dedicated fleet sends campaign
copy off live campaigns (D54/D55). Blacklist alone does not burn a domain.
Canary launch is a separate project (not in this loop).

First health after this lands runs a one-shot hold rebuild (D44): HOLDs
without a same-ESP fail are released into D43. Proven same-ESP fails stay.
New weak same-ESP / bounce still pull. Do not treat leftover HOLD-UNTIL
tags as the rotation system.

## Mailbox settings

Every mailbox is converged each run to:
- `MESSAGE_PER_DAY` (30) — Smartlead **"Message Per Day (Warmups not included)"**
- `MAILBOX_MIN_TIME_GAP_MINS` (10) — **"Minimum time gap"**
- Warmup enabled (`WARMUP_TOTAL_PER_DAY` on its own field)
- Plain two-line signature `Name\\n{Brand}` when a brand is known

Settings are per mailbox, so anything added by hand or re-imported arrives on
a default and needs reconciling.

## Placement tests

Tests are **recurring, not new-daily**: `POST /spam-test/schedule` with
`every_days: 1` creates one parent test per campaign that SmartDelivery
re-runs itself. The count does not grow daily and nothing needs deleting each
morning.

`TOTAL_TEST_QUOTA` defaults to **0 (unlimited, D45)**. Josh has unlimited
SmartDelivery tests. A positive value still caps, and scanner / held / rest
creates block rather than exceeding it. The 50-sender batch size is a
SmartDelivery API limit, not a plan quota. The reconciler stops a recurring
test when its campaign goes inactive.

**Launch bar is 85% same-ESP** (promo tab = miss, D46). Live pull stays
**80%** same-ESP (D32). Do not launch at 80 or pull at 85.

## Spend

`REQUIRE_SPEND_APPROVAL` stays **on**. Real-money spend is held for human
approval via `/approvals`. Do not disable it to make an automation smoother.

Approvals are **single-use**: only a pending record may be approved or denied,
and a successful external purchase consumes it. Client-scoped spend must carry
the $25 domain / 25 mailbox monthly-cap metadata; omitting it is a hard block.

## Operational API

`/status`, `/run`, and `/approvals/*` contain or mutate sensitive production
state. They require `RUN_TOKEN`; when no token is configured they stay disabled,
not public. `/health` is the only unauthenticated operational endpoint.

`/ops` is the employee surface. It uses independent owner/operator login keys,
signed HttpOnly sessions, CSRF protection, role checks and a persisted audit
log. Fast chat commands stay allowlisted. Freeform chat (when `CURSOR_API_KEY`
is set) goes to a Cursor Cloud Agent on **Grok 4.5 High Fast** — same style as
Josh's agent — and may open PRs, but still cannot spend, purge, bypass safety
gates, or deploy production directly (D18/D20).

Cayden may check placement/campaigns/DNS, reconnect mailboxes and perform a
confirmed one-mailbox rotation when every runtime precondition passes. Spending,
approval decisions, destructive teardown, safety-policy changes, bulk
remediation and deployment remain unavailable to the operator.

**Slack is only three things (D71).** A burned domain with receipts and
a cancel/replace button; an isolated spam word with Make the changes;
and one end-of-day client scoreboard (sends + spam). Health, rest, DNS,
lead-runout, staffing, and “you are on pod B” stay in logs. Slack that
people read is still plain English (D47).

## Campaign move safety

A pool mailbox named in `activeSwaps` is reserved for that recovery and is not
campaign top-up supply. A generic move must be compensating: if any Smartlead
write fails, undo the receiver add, restore removed donors and restore identity
before retrying.

## DNS

Sending-domain DNS is audited every monitor pass against public resolvers, not
any provider's status field. Missing SPF, duplicate SPF (RFC 7208 permerror)
and unresolvable domains alert; a neutral `?all`, missing DMARC and missing MX
are reported without paging.

The audit is **advisory and does not write DNS**. Pool zones live in InboxKit's
Cloudflare account; the only lever that rebuilds one changes nameservers on
domains that are actively sending.

DNS findings stay in logs (D71). They do not Slack.

## Warmup exemption mechanisms

They are not equivalent:

- `WARMUP-GATE-EXEMPT` tag (Smartlead, per mailbox) — skips **both** the
  under-warmed and `HOLD-UNTIL` checks
- `EXTRA_GENERIC_MAILBOXES` (env, by name) — skips the pre-warmed check only
- `EXTRA_GENERIC_DOMAINS` (env, whole dedicated fleet) — skips the pre-warmed
  check only and is authoritative for known pre-warmed fleet domains

Pick one deliberately. They have not been consolidated.

## Lead runout and sending IPs

Campaign audit watches **sender headcount**. Send volume watches **today's
sent count**. Remaining leads are a third number (D52): log at half,
three quarters, and done. Never import. Do not Slack runout (D71). A
working campaign running low is urgent in `/ops`; a silent campaign
running low is "do not top up."

Sending IPs come from placement reports we already pull (D53). Do not
buy an add-on until that census says the ranges are bad.

## Before changing behaviour

- `npm run typecheck && npm test` must pass
- `DECISIONS.md` is append-only — supersede by adding an entry, never by
  editing or deleting one
- Production truth comes from Railway logs, not assumption — the census,
  `[dns-audit]`, `[campaign-audit]` and `[top-up]` lines exist so state can be
  read rather than guessed
- Railway variable *values* are not readable over the OAuth connection; names
  are. Deploy code that logs what you need instead of guessing at config
