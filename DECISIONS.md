# Decisions

Append-only log of the repo owner's standing calls (Josh).

**Superseding means adding a new entry, never editing or deleting an old one.**
The reversals are the useful part — several entries here are the opposite of
the obvious answer, and the record of *why* is what stops someone re-deriving
the rejected version later.

Each entry states the decision, why it was made (including what was tried and
rejected), the tradeoff accepted, and the guard test that holds it if one
exists.

---

## D1 — Warmup is owed from the InboxKit import, not Smartlead's warmup record

**Decision.** A pool mailbox's warmup clock starts when it is imported from
InboxKit. It owes a full `POOL_WARMUP_DAYS` (14) before entering a live
campaign, whatever Smartlead reports.

**Why.** Production showed 2 of 202 mailboxes available and the assumption was
that the app had reset clocks that should have been older. Sourcing `warmedAt`
from Smartlead's `warmup_details.created_at` was implemented and shipped — it
moved 74 clocks *earlier*. Josh: "no i dont think those are actually warm
yet....the clock should start when i import them from inboxkit". A mailbox
bought from InboxKit is cold on arrival however long a Smartlead warmup row has
existed. Reverted, and the 74 rows were pulled back to the import time.

**Tradeoff.** Newly bought mailboxes are unusable for two weeks with no way to
shorten it. Accepted: rotating a cold mailbox into a client campaign is worse
than a campaign running thin.

**Guard.** `warmup clock counts from import, never from Smartlead`

---

## D2 — Generic from-names cover a fleet, not one mailbox

**Decision.** `EXTRA_GENERIC_MAILBOXES` entries are sender identities carried by
many mailboxes. Every account matching at or above the threshold is registered,
not just the best match.

**Why.** "harmony norris" is the from-name on ~100 mailboxes at
crosslaunchco.com and "breanna escobar" on ~100 at crossscaleco.com. Matching
returned a ranked list but registered only the top row, so 198 pre-warmed
generics were invisible and 100 sat idle on no campaign while the recovery swap
had 2 mailboxes to work with. Josh, after correcting it twice: "harmony norris
and breanna escobar are the names of 200 generic mailboxes i keep telling you
that and you are ignoring me."

**Tradeoff.** A too-loose matcher would sweep in unrelated people. Held by
keeping the score threshold — a surname-only hit scores below it.

**Guard.** `every mailbox behind a generic from-name is registered`

---

## D3 — Never move client-branded senders between campaigns

**Decision.** Campaign top-up draws from the generic pool only. A sender on one
client's domain is never reassigned to another client's campaign.

**Why.** Senders carry brand through their domain — Parlay sends from
`parlaytech*.info`, CultureFits from `culturefits*.info`. A proposal to move 41
senders from healthy campaigns to thin ones would have put one client's offer
behind another client's domain. Josh: "yes obviously only rotate in the client
specific or a generic domain/inbox".

**Tradeoff.** Top-up is limited by generic pool depth rather than total idle
capacity. Accepted.

**Guard.** `top-up fills only from the generic pool`

---

## D4 — Spend approval stays on

**Decision.** `REQUIRE_SPEND_APPROVAL` remains enabled. Real-money spend is held
for human approval via `/approvals`.

**Why.** Raised as a candidate for removal while automating away babysitting.
Josh: "but yes keep approval gate for spend". Buying mailboxes is the one action
here with direct cost and no undo.

**Tradeoff.** Automation stops and waits when it needs to buy. Accepted
deliberately.

**Guard.** `spend approval defaults to on`

---

## D5 — Two independent rotation signals

**Decision.** A sender comes off active campaigns when placement drops below
`REMEDIATION_INBOX_THRESHOLD` (80%) **or** bounce exceeds
`BOUNCE_RATE_THRESHOLD` (5%) on at least `MIN_BOUNCE_SAMPLE` (50) sends.

**Why.** Placement tests cannot see bounces — seed inboxes accept mail, so a
mailbox can hold a clean inbox rate while bouncing hard against real leads, and
bounce damages reputation faster. The sample floor exists because one bounce in
three is 33% and means nothing.

**Tradeoff.** A low-volume mailbox bouncing badly is not caught until it has
sent 50. Accepted over benching mailboxes on noise.

**Guard.** `bounce and placement are independent rotation signals`

---

## D6 — Benched senders sit 14 days

**Decision.** `RECOVERY_HOLD_DAYS` is 14. A sender pulled for placement or
bounce is held that long before returning.

**Why.** Josh: "anything under 80% gets rotated out to warm for 2 weeks, and a
generic is rotated in."

**Tradeoff.** Held senders are unavailable capacity — currently 184 of them.
Accepted.

**Guard.** `recovery hold is 14 days`

---

## D7 — Campaign floor of 50 senders, with exclusions

**Decision.** Every ACTIVE campaign is topped up to `MIN_CAMPAIGN_SENDERS` (50).
`TOP_UP_EXCLUDE_CAMPAIGNS` holds campaigns to leave alone — currently MSRS,
HVAC and Roofers.

**Why.** The recovery pool only swaps one-for-one against a benched sender, so a
campaign that launched thin stayed thin — one was sending on 7 senders. Started
at 30, raised to 50.

**Tradeoff.** A large single change to live campaigns when the floor moves.
Mitigated by processing neediest-first.

**Guard.** `campaign floor and exclusions are configurable, exclusions match
exactly by id`

---

## D8 — Placement tests are recurring, capped at 120

**Decision.** One recurring test per campaign (`every_days: 1`), not a new test
daily. `TOTAL_TEST_QUOTA` is 120 and the scanner blocks rather than exceeding
it. The reconciler stops a test when its campaign goes inactive.

**Why.** Josh asked whether tests accumulate daily and needed a way to stay
under 120. They do not accumulate — SmartDelivery re-runs the parent test.

**Tradeoff.** None identified.

**Guard.** `test quota is enforced before creating tests`

---

---

## D9 — A generic is supply while its campaign keeps the floor

**Decision.** Generics already serving a campaign are legitimate supply for
topping up a thin one. A generic may be taken whenever every campaign it
currently sends for would still hold `MIN_CAMPAIGN_SENDERS` (50) after losing
it. Taking it is a **move**, not a copy: it is removed from the donor,
added to the receiver, and its signature and from-name rewritten to the
receiving client.

**Why.** TechEvo runs on 100 crosslaunchco.com generics — 50 more than its
floor — while Parlay2 was sending on 7. A first attempt at this treated any
generic on a campaign as untouchable, which strands surplus where it is not
needed. Josh: "a generic should only be unavailable if pulling it would drop a
campaign below 50."

The move must be complete. The first implementation only called
`addEmailAccountsToCampaign`, leaving the mailbox on both campaigns while
carrying just the new client's signature — so the donor campaign was sending
under the wrong brand. Removing from the donor is part of the same operation,
not an optimisation.

**Tradeoff.** A campaign above the floor can lose senders to a thinner one, so
headcount moves around between runs. Accepted: the floor is what matters, and
surplus sitting idle helps nobody. Donor counts are tracked as the run
proceeds, so several moves in one pass cannot walk a donor below the floor.

**Guard.** `D9: a generic is taken only while its donor keeps the floor`

---

## D10 — Client-branded senders are still never moved

**Decision.** D9 applies to generics only. A sender on a client's own domain
is never reassigned to another client's campaign, whatever the headcounts.

**Why.** D3 already says this, and D9 could be misread as relaxing it. It does
not: `parlaytech*.info` belongs to Parlay whether Parlay has 7 senders or 700.
Only generics are brand-neutral enough to carry a different client's identity.

**Tradeoff.** None — a thin campaign with no generics available stays thin and
is reported rather than filled incorrectly.

**Guard.** Covered by the top-up drawing solely from the pool (D3).

---

## D11 — Every mailbox holds 30 campaign sends per day, warmup on

**Decision.** `MESSAGE_PER_DAY` is 30 and every mailbox is converged to it each
run, with warmup enabled. This is the campaign send cap, not the warmup volume
— they are separate Smartlead fields.

**Why.** Josh: "make sure warmup is turned on In smartlead for all mailboxes
and sending limit is 30 per day", confirmed as "30 per day is campaigns sending
limit". Settings are per mailbox, so anything added by hand, re-imported, or
provisioned by InboxKit arrived on whatever default it happened to get and
nothing reconciled them.

**Tradeoff.** A hard ceiling of roughly 30 × 1,241 sends/day across the fleet.
Accepted knowingly — volume per mailbox is the lever that protects reputation.

**Guard.** `mailbox send cap is 30 per day`

---

## D24 — Message Per Day is 30; warmups are not included in that field

**Decision.** Write Smartlead `max_email_per_day` = `MESSAGE_PER_DAY` (30).
That field is the UI **"Message Per Day (Warmups not included)"**. Warmup
volume stays on its own field (`WARMUP_TOTAL_PER_DAY` / `warmup_max_count`).
Do **not** add warmup into the daily message cap.

**Why.** An earlier reading treated `max_email_per_day` as a shared
campaign+warmup pool and wrote 50. Josh showed the Smartlead UI label:
warmups are not included. Writing 50 overstated campaign volume.

**Tradeoff.** Campaign sends per mailbox are hard-capped at 30 again. Correct
per owner.

**Guard.** `D24: Message Per Day is 30 and warmups are not included`

---

## D12 — A sender belongs to one campaign at a time

**Decision.** A generic found on more than one active campaign is released from
all but the one it is branded for, before any top-up runs.

**Why.** The first top-up added to the receiving campaign without removing from
the donor, so 66 generics sat on TechEvo *and* Parlay2/CultureFits while
carrying only the receiving client's signature — TechEvo was sending under
Parlay's brand. D9 fixed the forward path; this cleans up what the broken path
left and stops it recurring.

**Tradeoff.** Releasing duplicates can drop a campaign below the floor. That is
intended: the same run then refills it from the pool, with correct branding.

**Guard.** Covered by D9's move-not-copy rule.

## Open — not decided, do not guess

These came up and have not been settled. Ask before acting on either.

- **Is the MSRS/HVAC/Roofers exclusion permanent or temporary?** Written as
  config, not as a rule, so it can change without a code change.
- **Two competing warmup-exemption mechanisms exist** and are not equivalent:
  Cayden's `WARMUP-GATE-EXEMPT` Smartlead tag skips *both* the under-warmed and
  `HOLD-UNTIL` checks, while `EXTRA_GENERIC_MAILBOXES` skips only the
  pre-warmed check. Which is authoritative has not been decided, and they have
  not been consolidated.

## Not covered by a guard

- **DNS is advisory only.** The audit never writes DNS; pool zones live in
  InboxKit's Cloudflare account. This is a property of what the code does not
  do, and a test asserting the absence of a capability would pass trivially
  forever. Stated here instead of pretended to be covered.

---

## D13 — Operational state and writes always require RUN_TOKEN

**Decision.** `/status`, `/run`, and `/approvals/*` are disabled when
`RUN_TOKEN` is absent and require the token when configured. `/health` remains
public and contains no mailbox-level records.

**Why.** Production `/status` exposed the full pool, held inboxes, client
assignments and spend decisions without authentication.

**Tradeoff.** Operators must carry the token for diagnostics. Accepted.

---

## D14 — Recovery swaps are reserved; campaign moves compensate failures

**Decision.** A generic covering an active recovery swap cannot be taken by
campaign top-up. Other generic moves add the receiver first and compensate
every completed write if a later step fails.

**Why.** Top-up previously selected any `assigned` generic and moved donors
before proving the receiver write would succeed, which could break a recovery
swap or strand a sender between campaigns.

**Guard.** `CampaignTopUpService safety`

---

## D15 — Spend approvals are pending-only, single-use, and capped

**Decision.** A denied approval cannot be reversed. An approved request is
consumed only after the external action succeeds and can never authorize a
later purchase. Client-scoped spend must include monthly-cap metadata and is
hard-blocked above $25 domains / 25 mailboxes.

**Why.** Approval records previously stayed approved forever and the documented
monthly caps were not connected to the gateway.

**Tradeoff.** A later recurrence of the same need requires a fresh approval.
Accepted.

**Guard.** `spend approval state` and `SpendGateway`

---

## D16 — Persistent DNS failures alert at most weekly

**Decision.** A domain/issue combination alerts once, then has a seven-day
cooldown. A changed issue is a new alert.

**Why.** DNS runs every six hours; an unchanged SPF fault otherwise repeats
four times a day.

---

## D17 — The campaign floor is 50; mailbox cap is 30/day

**Decision.** The shipped fallback is 50 senders per active campaign and
`max_email_per_day` remains 30.

**Why.** D7 and D11 already recorded these values, but the config fallback
still said 30 senders. Josh reconfirmed both values during the safety review.

**Guard.** `D7: campaign top-up is on with a 50-sender floor` and
`D11: mailbox send cap is 30 per day`

---

## D18 — Employee chat is an allowlisted operations console, not a shell

**Decision.** Cayden may use `/ops` daily to check deliverability, campaign
coverage, DNS, reconnect mailboxes, and preview/confirm a single safe mailbox
rotation. Fast paths stay allowlisted. Freeform questions are handled by D20.

Still refused in chat (local hard deny):

- Spending and approval decisions
- Domain/mailbox deletion or purge
- Warmup/hold bypasses
- Fleet threshold, 50-sender floor or 30/day changes
- Bulk remediation
- Direct production deploy / force-push

**Why.** Cayden needs daily operational access without production credentials
or unreviewed spend. A free-form agent with Railway/Porkbun/InboxKit wallet
secrets would let an employee spend or override safety policy.

**Tradeoff.** Instant ops stay allowlisted; investigation/fixes go through
Cursor (D20) as PRs, not live production writes.

**Guards.** `ops chat policy`, `OpsAuth`, and `ManualRotationService`.

---

## D20 — Freeform Ops chat is Cursor Grok 4.5 High Fast

**Decision.** When `CURSOR_API_KEY` is set, unrecognized `/ops` chat (and
explicit “ask cursor …”) launches or continues a Cursor Cloud Agent on this
repo with model `grok-4.5` and params `effort=high,fast=true`. One durable
agent id is stored per Ops username. Allowlisted commands still run locally
without calling Cursor.

**Why.** Josh’s original ask was for Cayden to chat with the same assistant.
The local allowlist is great for safe instant ops; freeform diagnosis and
PR-based fixes need the real Cursor agent loop.

**Tradeoff.** Cloud Agents bill at Cursor API rates and can open PRs. They do
not receive Railway spend secrets via this app. Spend/delete/bypass remains
locally denied before the agent is invoked. Josh must keep Cursor dashboard
secrets tight.

**Guards.** `CursorAssistantService`, `CURSOR_API_KEY`, D18 hard denies, audit
log action `cursor-agent`.

---

## D21 — Repeated code failures launch an auto bug remediator

**Decision.** When `ENABLE_BUG_REMEDIATOR` is on (default) and `CURSOR_API_KEY`
is set, scan/monitor/remediation errors are classified. After the same
fingerprint hits a threshold (default 2) and is off cooldown (default 24h), a
Cursor Cloud Agent opens a fix PR. With `BUG_REMEDIATOR_AUTO_MERGE=true`
(default), the agent is instructed to merge after CI is green so Josh does not
have to babysit. Transient noise (429s, SURBL) and auth/access problems never
launch an agent.

**Why.** Placement-test and SmartDelivery validation bugs kept needing a human
to notice, classify, and ship a PR. The remediator turns “same error twice”
into an unattended draft/merge loop under the same spend/delete/hold guards as
Ops chat (D18/D20).

**Tradeoff.** Cloud Agents bill at Cursor rates and may open noisy PRs for
`unknown` failures. Mitigated by fingerprint cooldown, noise filters, and hard
prompt rules (no spend, no delete, no hold bypass, no reversing DECISIONS).
Turn off with `ENABLE_BUG_REMEDIATOR=false` or unset `CURSOR_API_KEY`. Set
`BUG_REMEDIATOR_AUTO_MERGE=false` if merges must stay manual.

**Guards.** `failureClassifier`, `BugRemediator`, owner-intent D21, manual
`POST /run?mode=bug-remediate`.

---

## D25 — Campaign health is the staffing brain (connected+inboxing floor)

**Decision.** `CampaignHealthService` is the sole mutator for campaign
staffing. The floor (`MIN_CAMPAIGN_SENDERS`, 50) counts only **staffable**
senders: connected SMTP/IMAP, not on a recovery hold, and not known-bad on
placement/warmup reputation. Mere campaign membership (disconnected or
spammy) does not pad the count. Protective pauses (last-account remove from
warmup gate / remediation) are recorded as `pendingResumes` and auto-`START`
once staffed. A fast `CRON_HEALTH` (default every 15m) runs reconnect →
mailbox settings → refill/unpause. The slower `CRON_MONITOR` keeps Measure
work (placement, remediation, DNS, warmup gate). Smartlead writes go through
a serial `MutationQueue`. Slack fires when a shortfall cannot be closed.

**Why.** Outreach dies when campaigns look "full" on membership but have dead
or spammy mailboxes, or stay PAUSED after a protective last-account strip.
Staffing was buried inside the six-hour monitor next to Measure work, so thin
campaigns waited too long and rate limits collided with long remediation
runs. Josh's north star: keep every ACTIVE campaign staffed with connected,
inboxing senders without babysitting; Slack only when the system cannot fix
it. Measure is not optional theatre — it feeds the inboxing signal health
uses — but it must not block the refill loop.

**Tradeoff.** Unknown connectivity is treated as connected (partial Smartlead
payloads must not mass-understaff). Unknown placement is optimistic until
Measure/remediation marks a sender bad. Health reconnect every 15m can add
API load; mitigated by the mutation queue and reconnect's own in-flight
guard.

**Guards.** `staffableSender`, `CampaignHealthService`, owner-intent D25,
`CRON_HEALTH` boot log.

---

## D26 — One client per sender; many campaigns for that client (supersedes D12)

**Decision.** A sender belongs to **one client**, not one campaign. Client
inboxes and generics branded to that client may sit on **every ACTIVE
campaign for that client** at once (all BCP mailboxes on all BCP campaigns,
all Parlay mailboxes on all Parlay campaigns, etc.). Cross-client membership
is still forbidden and cleaned up. `ClientFanOutService` adds missing
same-client attachments each health pass. Top-up **adds** onto same-client
campaigns without removing from other same-client donors; it still **moves**
off other clients.

**Why.** Josh (2026-08-06): delete the old “generics only / BCP client-domain
only / one campaign per sender” staffing rules. “All client inboxes or a
generic can be for multiple client campaigns. So all bcp mailboxes should be
on all bcp campaigns.”

**Tradeoff.** Smartlead membership multiplies (one mailbox × N campaigns).
Accepted for reach. Excluded campaigns (MSRS etc.) still stay untouched.

**Guards.** `ClientFanOutService`, top-up same-client keep path, owner-intent
D26.

---

## D27 — Generics may staff any client including BCP

**Decision.** The generic pool may top up and recover-swap onto BCP and every
other client. The prior “BCP client-domain only / no generics on BCP” code
path is removed. BCP-owned domains still fan out across BCP campaigns (D26).

**Why.** Josh deleted the BCP-only and “generics aren’t for BCP” rules.

**Tradeoff.** Brand purity on BCP is weaker if generics are mixed in. Accepted
by owner.

**Guard.** Top-up no longer skips `isBcpCampaignName`; recovery pool no longer
skips BCP clients.

---

## D28 — Under 80% placement: check if the copy is the spam cause

**Decision.** Before benching senders for low placement, classify the
campaign’s provider split (`copySignal`). Outlook buried + Gmail healthy ⇒
**copy_likely** — do **not** rotate those senders; Slack to test/fix the
sequence copy. Single-provider weakness still rotates as mailbox/ESP local.
Bounce-driven rotation is unchanged.

**Why.** Josh: when a mailbox is under 80%, ensure it isn’t spam from the
copy — test the copy.

**Tradeoff.** Copy-likely campaigns may stay weak until someone edits the
sequence. Better than burning inventory for a content problem.

**Guard.** `copySignal`, remediation copy defer, owner-intent D28.

---

## D29 — PAUSED campaign with >7% sender bounce: investigate (unless copy)

**Decision.** On the monitor pass, any PAUSED campaign (except our own
last-account protective pauses) whose senders’ aggregate bounce exceeds
`CAMPAIGN_BOUNCE_INVESTIGATE_THRESHOLD` (7%) is investigated. If placement
says copy_likely (D28), Slack only. Otherwise rotate the worst bouncing
senders off that campaign, re-enable warmup, and attempt `START` if senders
remain.

**Why.** Josh: if a campaign is paused because sender bounce is over 7%,
investigate and remediate unless it’s the campaign copy.

**Tradeoff.** 7% investigate threshold is separate from the 5% per-sender
rotation threshold (D5). A campaign can be investigated without every sender
crossing 5% if the weighted aggregate is high.

**Guard.** `CampaignBounceInvestigateService`, config default 7, owner-intent
D29.

---

## D30 — Every mailbox holds a 10-minute minimum send gap

**Decision.** Every mailbox is converged to `MAILBOX_MIN_TIME_GAP_MINS` (10)
via Smartlead `time_to_wait_in_mins` (UI **"Minimum time gap (min)"**). Empty/0
is not allowed.

**Why.** Josh: gap was blank/0 and that caused throttling — campaigns burst
sends across mailboxes with no per-mailbox spacing. Set 10 on every mailbox
and keep it as a standing rule.

**Tradeoff.** Theoretical max pace per mailbox is 6 campaign sends/hour. Accepted
to stop burst throttling.

**Guard.** `D30: every mailbox holds a 10-minute minimum send gap`

---

## D35 — Mailbox min-gap is enforced on every health pass

**Decision.** The 10-minute mailbox Minimum time gap (D30) and 30/day volume
(D24) are converged on **every** health cron (`*/15`), not only on the 6-hour
full mailbox-settings pass. Signatures/warmup stay on the 6-hour full converge.
Fan-out and top-up writes also set `time_to_wait_in_mins` + `max_email_per_day`
when attaching or moving a mailbox. Drift triggers a dedicated Slack alert.

**Why.** Josh (2026-08-11): Dave Ackley / Goliath bounce spike — suspected blank
mailbox gap. Campaign account GET and email-account GET-by-id omit
`minTimeToWaitInMins` (list endpoint is source of truth), and a 6-hour-only
converge is too slow after fan-out/import. Gap must be checked all the time.

**Tradeoff.** Health cron does an extra list+conditional-write pass every 15
minutes. Accepted over another burst day.

**Guard.** `D35: health enforces mailbox min gap every pass`

---

## D31 — Mailbox signatures are plain two-line Name / Brand

**Decision.** Every mailbox with a resolvable brand is converged to a plain
text signature:

```
First Last
{Client Brand}
```

HTML `<div>` pairs are rewritten to newlines. Existing second-line brand text
is preserved when present; otherwise the Smartlead client logo/brand is used.
Unassigned pool inventory with no brand is left alone.

**Why.** Josh: signatures must be two lines (name, then company), not a single
line or HTML blob.

**Guard.** Covered by mailbox-settings converge + `desiredMailboxSignature`.

---

## D32 — Never rotate on a blended (all-ESP) placement score

**Decision.** Placement-based rotation uses **same-ESP inbox % only**
(Gmail→G Suite / Outlook→O365) with at least `MIN_SAME_ESP_SAMPLES` seeds.
The blended / all-ESP score is display-only. If same-ESP samples are thin,
**do not** fall back to blended and pull the mailbox. Bounce rotation (D5) is
unchanged and does not need placement.

**Audit — 2026-08-06 remediation waves.** Last rounds still had blended-eligible
paths: thin same-ESP samples fell back to all-ESP `inboxRate`, and a worse
blended row from another test could overwrite a healthy same-ESP row. Holds
marked `scoredSameEsp=false` (e.g. `escob_breanna@crossscaleco.com` at 18:12Z)
are the fingerprint. Josh: ignore the blended score; stop pulling because of it.

**Why.** Josh has repeated this rule many times. Blended scores mix provider
filters and create false benches while the matched ESP is fine (or invent a
placement pull when we simply lack same-ESP evidence).

**Tradeoff.** Some weak senders wait until the next test has enough same-ESP
seeds. Accepted over burning inventory on blended noise.

**Guards.** `D32: never rotate on blended placement`,
`shouldRotateForPlacement`, `preferSenderInboxRate`, `SCORE_SAME_ESP_ONLY`
defaults on.

---

## D19 — Pre-warmed fleets are identified by domain and persisted state

**Decision.** Every mailbox on `crosslaunchco.com`, `crossscaleco.com`, and
`cleartechco.com` is pre-warmed. The warmup gate exempts those domains and any
pool row marked `prewarmed`; fuzzy name matching is only an additional fallback.

**Why.** Smartlead reported a recent warmup timestamp and variant identity
`Brianna Escobar` for 12 `crossscaleco.com` mailboxes. Exact matching against
`breanna escobar` failed, so the warmup gate incorrectly removed all 12 from
TechEvo despite the fleet having been bought pre-warmed. Josh: Clear Tech Co
(`cleartechco.com`) is likewise pre-warmed — put pulled inboxes back and ignore
them from the under-warmed rule.

**Tradeoff.** A future cold mailbox added to an explicit fleet domain would
also be treated as pre-warmed. Accepted: those domains are dedicated,
operator-managed pre-warmed inventory.

**Guard.** `warmupGate helpers — explicit pre-warmed fleet domain`

---

## D36 — Copy detection is provider-agnostic (supersedes D28's direction rule)

**Decision.** `copySignal` treats a **wide split between providers** as
copy_likely regardless of which provider is buried: when the best provider is
at or above the placement threshold and another sits `COPY_DIVERGENCE_POINTS`
(40) or more below it, that is a copy/offer signal and sender rotation defers.
D28's original Outlook-buried branch is kept and still fires; this adds the
general case beneath it. Everything weak together stays **ambiguous** — that
may be the domain, not the copy.

**Why.** D28 named Outlook as the buried side, so a Gmail-buried offer read as
"local to that ESP/mailbox" and never raised the copy flag. Goliath L3
Manufacturing Defense showed the flaw with a controlled pair on 2026-08-12: the
same 100 `cleartechco.com` senders scored **100% Office365 / 100% G Suite** on
the *Tickets* offer and **100% Office365 / 36% G Suite** on the *AirPods*
offer, same day, same lead segment. A mailbox fault cannot land 100% on one
provider and 36% on another — the message is the variable. Mirroring the rule
alone would still have missed it, because the original branch requires the
buried side under 20% and Gmail read 36%.

**Tradeoff — read this before approving.** A provider-specific *reputation*
problem (e.g. Google Postmaster damage on a sending domain) produces the same
provider-level shape as a copy problem, and `classifyCopySignal` only sees one
campaign's provider split. Such a case would now be misread as copy and sender
rotation would defer, leaving a genuinely damaged domain sending. The Goliath
evidence separates the two only because sibling campaigns share senders and
score 100% — information the function does not receive. Accepted for now
because the failure mode is a *delay* in rotation with a Slack nudge attached,
not a silent one; the stronger fix is to compare campaigns that share senders.

**Guard.** `copySignal` — `D36 — divergence is provider-agnostic`,
`COPY_DIVERGENCE_POINTS`, owner-intent D36.

---

## D39 — Slack client day brief + separate tests for held/pulled mailboxes

**Decision.** Fleet Slack is **per client**, not per mailbox: day sent, bounce %,
spam % (from latest placement), and how many client inboxes are active vs
**held** (pulled off campaigns).

Mailboxes that are held / pulled off live campaigns get **their own** recurring
SmartDelivery tests. Those tests use a campaign only as a sequence shell and
list the held emails as `sender_accounts` — they are **not** re-attached to
live campaigns. When every mailbox on a held-recovery test leaves the hold set,
the test is stopped to free quota.

A/B/C weekly rest cohorts are **not** part of this decision (deferred).

**Why.** Josh (2026-08-17): Slack should show client-level day stats and
active/held counts; pulled mailboxes must keep earning same-ESP scores without
sitting back on live campaigns.

**Tradeoff.** Each held batch consumes a SmartDelivery test slot against
`TOTAL_TEST_QUOTA` (120). Sequence shell must still resolve from a former or
ACTIVE campaign.

**Guards.** `HeldPlacementTestService`, `ClientDayBriefService`, test reconciler
held-recovery keep path, owner-intent D39.

---

## D40 — Manual campaign stop/pause is never auto-resumed

**Decision.** If an operator stops or pauses a campaign by hand, automation
must not `START` it again.

- Health may `START` **only** campaigns in `pendingResumes` (pauses **we**
  took for last-account / warmup-gate / remediation), and only while status is
  still `PAUSED`.
- `STOPPED` (or any non-`PAUSED` status) clears `pendingResumes` and is never
  resumed — that is the operator taking over.
- Paused-campaign bounce investigation (D29) may still rotate bad senders and
  Slack, but it **must not** `START` the campaign. That part of D29 is
  superseded.

**Why.** Josh (2026-08-18): “if I stop a campaign manually, do not auto
resume.” Bounce-investigate was STARTing manually paused campaigns after
rotating bouncers.

**Tradeoff.** A campaign we protectively paused stays in `pendingResumes` and
can still auto-resume when staffed. To keep a protective pause down
permanently, set the campaign to **STOPPED** (or clear the pending-resume
marker). Manual `PAUSED` without a pending-resume is never STARTed.

**Guards.** `CampaignBounceInvestigateService` (no START),
`CampaignHealthService` STOPPED path, owner-intent D40.

---

## D41 — Beanstalk rotation: 2/2 rest, canary, 21-day fresh warmup

**Decision.** Client inboxes (not generic fleet domains / pool generics) work
**2 weeks on / 2 weeks off**. Cohort is a stable hash of the email (A/B).
The fortnight follows ISO weeks in America/New_York. Off-week mailboxes are
**removed from live campaigns** — not left on at `MESSAGE_PER_DAY=0`. Warmup
stays on. Resting does **not** count as staffable.

This **qualifies D26**: a resting mailbox is not fanned onto every ACTIVE
campaign for that client. Cross-client membership is still forbidden.
Generics remain the spare tire and do not rest; they may staff any client
including BCP (D27). ~50 staffable senders is still the campaign floor.

Health may **veto** putting a rester back on if same-ESP inbox is known-bad.
No score ⇒ allow the first swap so rotation can start. Fan-out, top-up,
health, remediation restore, BCP restore and ops rotate skip resters.

Off-week mailboxes get **separate** SmartDelivery tests (same pattern as D39
held tests). Slack client-day briefs show **on / off / generic-spare / held**.

**Canary.** A campaign whose `created_at` is within 7 days gets ~15% of
on-week client inboxes until it graduates. If **3+ unrelated sending domains**
drop on same-ESP, pause **that campaign only**. Do not auto-`START` (D40).

**Fresh warmup.** Non-prewarmed inboxes owe **21 days** from the existing
warmup-gate clock before a live campaign. `POOL_WARMUP_DAYS` and
`MIN_CAMPAIGN_WARMUP_DAYS` stay **14** (D1). Pre-warmed fleets stay exempt.

**Bounce warn.** Slack/investigate at **~2%** bounce (with the usual sample
floor). The **5% sender pull** (D5) and the **7% paused-campaign investigate**
(D29) are unchanged.

**Burn.** Blacklist alone is not enough to purge a domain. Require a named
non-SURBL listing plus corroborating same-ESP placement fail or bounce over
the pull threshold. Approval still gates the spend (D4/D15).

**DNS.** The advisory audit also reports DKIM selector TXT (common Google /
Microsoft selectors) and DMARC `p=none`. It still does not write DNS.

**Why.** Josh (2026-08-21): implement the Beanstalk-style rest for client
inboxes, keep generics as spare capacity, start new campaigns on a canary
slice, give fresh InboxKit boxes 21 days, warn at 2% bounce, and do not
burn a domain on a blacklist hit alone.

**Tradeoff.** Rest tests compete with campaign + held tests against the 120
quota. A campaign that is all off-week client inboxes waits one health pass
for generic top-up before the last account can come off. Canary pause is
manual to unstick (D40).

**Guards.** `ClientRestService`, rest skip in fan-out/top-up/health/restore,
`owedWarmupDays`, `burnChecklistReady`, `bounceRateWarnThreshold` default 2,
`freshInboxWarmupDays` default 21, `poolWarmupDays` still 14, owner-intent D41.

---

## D42 — Generics rest on the same 2/2 cadence

**Decision.** Pool generics and pre-warmed fleet senders rest on the **same**
2 weeks on / 2 weeks off A/B cohort as client inboxes (D41). Off-week generics
are removed from live campaigns (warmup stays on) and are **not** top-up or
recovery-pool supply. The on-week half remains the spare tire that fills the
50-staffable floor.

Canary still applies only to the ~15% client-inbox slice; restoring an
on-week generic onto a canary campaign is allowed (generics may top up to 50).

This **qualifies D41** where it said generics do not rest.

**Why.** Josh (2026-08-21): generics also need to rest after 2 weeks — leaving
them on forever burns the spare tire the same way client inboxes burned.

**Tradeoff.** Roughly half the generic pool is unavailable each fortnight, so
thin pools may leave campaigns short until the next on-week. Last-account rest
still waits for top-up rather than emptying a campaign.

**Guards.** `isRestEligibleMailbox`, resting filter in
`findAvailablePoolMailbox` / `findReassignablePoolMailbox`, owner-intent D42.

---

## D43 — Per-client A/B rest, generic send clock, no canary in this loop

**Decision.** Client rest is an **even A/B split per client**, not a global
email hash. That client's off-week half leaves ACTIVE campaigns (warmup on).
Resting is not staffable and does not fan out. Health then tops every live
campaign to **50 staffable** with generics and keeps at least **~30% Google
and ~30% Microsoft**.

Generics do **not** sit on the same fortnight as clients (qualifies D42).
A generic sits after **~14 days of live send**, then becomes supply again
after the same sit. Clocks start when we first see the box on an ACTIVE
campaign (or from pool `assignedAt`). Staggered — half the spare tire does
not vanish the morning clients sit.

**Canary** (7-day / 15% slice / pause on 3+ domain drops) is **out of this
loop**. It is another project.

MSRS and other `TOP_UP_EXCLUDE_CAMPAIGNS` stay excluded from rest and top-up.
Manual pauses still do not auto-START (D40). Fresh warmup stays 21 days (D41).

**Why.** Josh (2026-08-21): the global hash + same-fortnight generic rest
was too complicated. Split each client's inboxes A/B, drop the off half,
backfill to 50 with generics, keep both ESPs, and track generic tenure
separately. Canary is a later project.

**Tradeoff.** Existing generics without `assignedAt` get a fresh 14-day clock
on first sight after deploy, so we do not bench the whole fleet on day one.

**Guards.** `assignClientCohorts`, `isRestEligibleMailbox` client-only,
`GenericSendRestService`, `espFillOrder` 30% default, no canary config,
owner-intent D43.

---

## D44 — Rebuild the hold pile so D43 is the rotation system

**Decision.** One-shot after deploy: release every HOLD that lacks same-ESP
proof. Keep only `scoredSameEsp === true` and same-ESP inbox rate below
`REMEDIATION_INBOX_THRESHOLD` (80%). Strip `HOLD-UNTIL-*` tags on released
boxes, clear `heldInboxes` and the swap reservation. Do not yank covering
generics off campaigns. Do not touch `WARMUP-GATE-EXEMPT`.

Going-forward placement (same-ESP) and bounce pulls stay (D5/D32). This is
not a new rest method — it clears the graveyard so per-client A/B and the
generic send clock can take over.

**Why.** Josh (2026-08-21): existing HOLDs are not known-weak. Census that
day: 236 held, 108 with no same-ESP score, 61 already expired. Treating the
tag pile as rotation stranded senders that should be on D43.

**Tradeoff.** Bounce-only historic holds are released; if bounce is still
over 5% with 50 sends, D5 re-holds them on the next remediation pass. The
rebuild stamps `restBaselineRebuiltAt` and does not run again.

**Guards.** `holdHasSameEspProof`, `RestBaselineRebuildService` one-shot,
owner-intent D44.

---

## D45 — Placement-test quota is unlimited (0)

**Decision.** `TOTAL_TEST_QUOTA` defaults to **0**, meaning unlimited.
Scanner, held-recovery tests, and rest-recovery tests must **not** block
when the quota is 0. A positive value still caps and blocks (old D8
behaviour). This supersedes D8's **120 cap only**. Recurring daily
schedules, **≤50 senders per test** (SmartDelivery API limit, not a plan
quota), and the inactive-campaign reconciler stay (D8).

**Why.** Josh (2026-08-21): he has unlimited SmartDelivery tests. The 120
cap was leftover from the old plan and was refusing campaign / held / rest
creates.

**Tradeoff.** Every eligible ACTIVE campaign (plus held/rest batches) can
get a schedule. Idle or zero-lead ACTIVE campaigns become more expensive
to leave tested — skip those rather than re-capping (see open PR #62).

**Do not** change Railway `TOTAL_TEST_QUOTA` until this code is on `main`.
Production still has `TOTAL_TEST_QUOTA=120`, and older deploys reject `0`
(`.positive()`). After merge: delete the var or set `TOTAL_TEST_QUOTA=0`.

**Guards.** owner-intent D45 (default 0), `quotaWouldBlock` treats 0 as
unlimited.

---

## D46 — Campaign launch placement bar is 85%

**Decision.** A new campaign does not go ACTIVE until a SmartDelivery test
of the **real attached sender set** scores **≥85% same-ESP**, with Gmail
Promotions counted as a miss. That is the **pre-launch** bar (campaign-setup
skill / Claude). It does **not** change live rotation: health still pulls at
**80%** same-ESP (D32) or bounce over 5% with 50 sends (D5).

**Why.** Josh (2026-08-21): launch on a harder bar than the live pull, and
treat promo tab as a miss for cold outbound.

**Tradeoff.** Some campaigns wait longer or launch on a smaller survivor set.
Do not waive from chat.

**Guards.** `campaignSetupPrompt` 85% launch / 80% live; owner-intent D46.

---

## D47 — Slack that people read is plain English

**Decision.** Every Slack message the app sends must be readable by Cayden
without D-numbers, API field names, or internal labels. Say what happened
and what to do. Logs, `DECISIONS.md`, and `/ops` chat prompts may keep the
jargon. Slack may not.

No `D43`, `same-ESP`, `staffable`, `fan-out`, `HOLD-UNTIL`, `ESP-matched`,
`Fingerprint`, env var names, or `monthly quota`. Say “inbox test for that
mailbox type,” “sending inboxes,” “same-client inboxes,” “sitting after a
bad test,” “matching spare,” “same error N times,” “a cap we set.”

**Why.** Josh (2026-08-21): Cayden works from Slack. Jargon updates are
noise. Tonight’s hold rebuild / rest / top-up notes were the example.

**Tradeoff.** Messages get a bit longer. A person who wants the exact field
name still has the logs.

**Guards.** `slackJargonHits` / `slack.plainEnglish.test.ts`; owner-intent D47.

---

## D48 — Isolation system: report-only on campaigns, unlimited tests

**Decision.** When a campaign is in spam, the wizard answers **inboxes vs copy**, and if copy, **which element**. It does that with standing per-pod control tests plus a low-rep isolation rig. It **never** pauses, edits, launches, or attaches isolation-domain mailboxes to a production campaign. Slack recommends the fix; a human edits the sequence.

Standing controls are keyed to a **pod** (that client's A group, B group, or the generic sending / sitting piles), not to each campaign. One control test (chunked at 50 senders — SmartDelivery's API limit) attaches every mailbox in the pod and is read **per sender**. A campaign inherits the reading of the mailboxes it is actually sending from. A burnt minority in an otherwise fine pod is still inboxes, not copy.

The control email is a versioned constant (no offer, no link, no spam vocabulary). Changing it starts a new `control_version`. A failed control is never a copy finding.

Copy teardown (one change per variant, same day, same isolation domain, in parallel) **starts on its own** when the verdict is copy. Do **not** hold those SmartDelivery tests for seed approval. Josh (2026-08-23): unlimited monthly tests — do not be stingy and do not ask. That qualifies the draft isolation plan's "estimate seeds and stop for approval" and "do not auto-run Phase 2" lines. `TOTAL_TEST_QUOTA` stays 0 (D45). Real-money spend (buying the isolation domain) still needs D4 approval.

Keep/watch/kill tags on control history are **evidence for a cull note**, not an automatic pull. Live rotation stays 80% same-ESP (D32) and 5% bounce (D5). Copy/offer still does not bench senders (D28).

Persistence stays the Railway state file (this app's system of record). Do not add a second database for isolation.

**Why.** Eric found "free" alone burying a campaign; "complimentary" fixed it in hours. At 75–95 words with one proof point, a single word is a live risk and there was no diagnostic. Live SmartDelivery against production pods is uninterpretable in both directions — trusted infra can land bad copy, and a struggling pod can bury good copy. A standing control on the pod, plus a deliberately low-rep rig for teardown, is the constant.

**Tradeoff.** Standing controls consume seeds every cycle. Accepted: tests are unlimited, and the alternative is guessing. The isolation domain must stay cold and off campaigns or it will start masking copy the same way production pods do.

**Guards.** Isolation denylist on `addEmailAccountsToCampaign`; failed control never `COPY`; one variable per variant; no seed-approval gate on isolation tests; owner-intent D48.

---

## D49 — Autonomous isolation; humans only for retire, buy, and copy

**Decision.** The wizard runs on its own: standing known-good tests, copy-vs-inboxes research, word hunting, daily rest, rotation, and filling campaigns back to 50 after a cut. A human is in the loop only for three things:

1. **Retire a domain** — Josh only, Slack button or Railway `/ops`.
2. **Buy replacement domains / mailboxes** — Josh only. Cayden cannot approve spend. Slack button is the approval (same D4 ledger; do not ask a second time in Approvals). Porkbun + InboxKit follow the existing onboarding path: spin `.info` names, buy at Porkbun, attach InboxKit nameservers, order mailboxes on the generic pool, register them `warming` (14 days from import).
3. **Change live copy** — Josh **or** Cayden, Slack button or `/ops`. One recovered word. That qualifies D48's "never edit the sequence": the hunt still starts alone; the live email changes only after a tap.

**Domains, not mailboxes.** Judge a domain only on the known-good email, never on campaign placement (copy fingerprinting must not condemn a domain). One domain-level fail cycle → count it in the buy-ahead number so replacements can warm. Two **consecutive** domain-level fails → ask Josh to retire. Fleet domains (`EXTRA_GENERIC_DOMAINS`) may die fleet-wide, but only when **several inboxes** fail (at least three). One or two readings is not enough. Sitting / off-week inboxes get the known-good test only; if those fail, they count toward that several.

**A campaign in spam is a flag**, not a death sentence. Something is wrong — inboxes **or** copy — and isolation is the research. Every diagnosis Slack/`/ops` shows proof: what ran, who failed, why it is not the other cause.

**Autonomy choice A.** Daily rest and fill-up stay automatic. Only killing a domain waits for Josh; after he approves, health fills on its own. Do not ask before every rest or rotation (that was C). Do not wait to restaff after an approved retire (that was B).

Josh's Slack user ids (`SLACK_JOSH_USER_ID`) and Cayden's (`SLACK_CAYDEN_USER_ID`) map button taps. Interactivity URL is `POST /slack/interactions` with `SLACK_SIGNING_SECRET`. `/ops` Isolation panel is the same queue in the Railway UI.

**Why.** The wizard was a dashboard Josh still had to interpret. After production showed cold clocks and copy-driven Outlook fails, the missing piece was: prove the cause, then only stop for money, a dead domain, or a live word change.

**Tradeoff.** Slack buttons spend real money once Josh taps. Accepted: that *is* the approval. Nameserver lag may delay mailbox orders; resume finishes them without a second tap.

**Guards.** Owner-intent D49; `canDecideIsolationAction`; domain rollup needs multiple fleet inbox fails; campaign placement does not open a retire.

---

## D50 — Live-send warmup is 21 days from InboxKit import

**Decision.** A mailbox owes **21 days** from InboxKit import before it may
send campaign copy or be handed out as pool supply. `POOL_WARMUP_DAYS` and
`MIN_CAMPAIGN_WARMUP_DAYS` default to **21**. `freshInboxWarmupDays` stays
**21**. Pre-warmed fleets (`EXTRA_GENERIC_DOMAINS` /
`EXTRA_GENERIC_MAILBOXES`) stay exempt and may send immediately.

This supersedes the **duration** in D1 and D41 (those said pool / campaign-min
stay 14). It does **not** reverse D1's clock: warmup is still owed from the
InboxKit import stamp (`warmedAt`), never from Smartlead's
`warmup_details.created_at`. The warmup gate prefers that pool stamp when
one exists.

Unchanged:
- Recovery hold after a bounce / placement pull stays **14 days** (D6)
- Generic send / sit rotation stays **~14 days** (D43)
- Warmup stays on for every mailbox

**Why.** Josh (2026-08-23): unwarmed mailboxes were still able to sit on
ACTIVE campaigns and send the campaign sequence. Fourteen days was not
enough; make the live-send clock 21 across the pool and the gate.

**Tradeoff.** Newly bought non-prewarmed mailboxes stay off live send for
an extra week. Accepted: campaign copy on a cold box is worse than a
thinner spare pile.

**Guards.** `poolWarmupDays` / `campaignMinWarmupDays` default 21;
`warmupClockStartedAt` prefers pool `warmedAt`; owner-intent D50.

---

## D51 — Kill-only pull; unwarmed campaign-copy canaries

**Decision.** Placement below 80% same-ESP, bounce above 5% after 50 sends,
under-warmed, and HOLD-UNTIL strip **do not pull** a mailbox off an ACTIVE
campaign. The only automatic live removal is Josh **killing that mailbox /
retiring its domain** (`retire_domain`). Health then backfills to 50
staffable on its own.

D5's 80% / 5% numbers stay as Slack / isolation **readings**, not pull
triggers. D32 still forbids blended scores as a rotation signal (there is
no metric rotation). D50's 21-day import clock stays the definition of
warmed vs unwarmed; it is no longer a gate that strips campaign copy.
`ENABLE_WARMUP_GATE`, `ENABLE_BOUNCE_ROTATION`, and
`ENABLE_LEGACY_MAILBOX_PULLS` default **off**.

Keep a small set of **purposely unwarmed** pool generics on each ACTIVE
campaign sending the **campaign sequence** (not the known-good control).
Default **3 per campaign**, extra to the 50 staffable floor, not counted
as staffable, not sat by the generic send clock, not pre-warmed fleets.
Isolation reads their campaign-copy placement against warmed peers:

- Unwarmed lands campaign copy while warmed peers fail → the copy is not
  the problem (inboxes / infra).
- Unwarmed and warmed both bury campaign copy, known-good lands → COPY.
- Unwarmed buries, warmed lands → warmup / age, not a word hunt.

Client A/B rest and generic send-rest (D43) stay. Cross-client top-up
donor moves stay. Manual ops rotation stays. Isolation-domain mailboxes
still never attach.

**Why.** Josh (2026-08-23): legacy pulls (placement, bounce, warmup gate)
are the old rules. Only pull when killing a mailbox and backfilling. Want
some cold boxes sending campaign copy so copy-vs-inboxes has a third
reading.

**Tradeoff.** A weak sender can stay on a live campaign until its domain
is retired. Accepted: isolation + rest + kill is the system; metric-driven
benching was the old one. A thin warming pile may leave a campaign short
of 3 canaries.

**Guards.** `enableWarmupGate` / `enableBounceRotation` /
`enableLegacyMailboxPulls` default false; `copyCanaryPerCampaign` default 3;
owner-intent D51.

---

## D54 — Dedicated unwarmed canary fleet (2 domains × 3 inboxes)

**Decision.** Campaign-copy canaries are a **bought research fleet**, not
still-warming pool generics. Buy **two new domains**, **three inboxes
each**: domain 1 Google, domain 2 Outlook. **Warmup stays off** on those
six mailboxes. They send the **live campaign sequence**.

They are not staffable supply (D25). Generic send-rest does not sit them
(D43). Mailbox-settings converge still writes daily volume and gap; it
does **not** turn warmup on for this fleet (qualifies “warmup on for
every mailbox”).

**D26 exception.** These six may sit on **every ACTIVE campaign**,
including across clients. They are research instrumentation, not a
client sender. Identity stays a fixed canary signature; do not assign
them as a client’s staffed from-name.

Spend is still Josh-only through the isolation Slack tap
(`buy_canary_fleet`) and the D4 ledger. “Just buy” in chat is owner
intent to implement the path, not a substitute for the tap.

Health requests the buy when the fleet is missing. After Josh taps,
nameserver lag and Smartlead export resume without a second tap.
`configureWarmup(..., warmup_enabled: false)` after import.

Do not pick `status === "warming"` pool rows as canaries anymore. D51’s
isolation reading (unwarmed vs warmed campaign copy) stays; only the
supply source changed.

**Why.** Josh (2026-08-23): the unwarmed canary should be purpose-bought
boxes that never turn warmup on — two domains, three inboxes each, one
Gmail and one Outlook — and those are the canaries that send.

**Tradeoff.** Six boxes total, not three fresh warming generics per
campaign. Accepted: a stable Google + Outlook pair is a cleaner reading
than a rotating warming pile, and it does not steal staffable supply.
Cross-client attach is an explicit D26 exception for this fleet only.

**Guards.** `COPY_CANARY_FLEET_DOMAIN_COUNT` 2;
`COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN` 3; `buy_canary_fleet` owner-only;
warmup never enabled for fleet emails; owner-intent D54.

---

## D55 — Canaries send campaign copy off live campaigns

**Decision.** The D54 fleet sends the **campaign sequence in SmartDelivery
placement tests**. It does **not** sit on Smartlead campaigns and does
not send to real leads. If a canary is on a campaign, pull it off.

One recurring `Canary copy: #{id}` test per ACTIVE campaign, senders =
the six fleet inboxes, body = that campaign’s live sequence. Isolation
reads unwarmed from that test and warmed from the campaign’s standing
test. The test reconciler stops a canary test when its campaign is no
longer ACTIVE.

This supersedes D54’s D26 exception (cross-client campaign membership).
That exception is no longer needed because they are not campaign
members.

Sending IPs are not added to Slack / campaign / placement reports. Ask
for the list when you want it.

**Why.** Josh (2026-08-23): do not put the canaries on campaigns; they
should run the campaign copy but stay off campaigns. Sending IPs are
wanted as a list, not in reports.

**Tradeoff.** Copy evidence comes from seed inboxes, not live lead send.
Accepted: that is the point of a research fleet.

**Guards.** `copyCanary.ts` never calls `addEmailAccountsToCampaign`;
owner-intent D55.

---

## D56 — Pod controls hang on a paused known-good shell

**Decision.** Standing pod-control tests use a dedicated Smartlead campaign
named **Pod control shell**. It stays **PAUSED** (D40 — never START it).
Its sequence **is** the versioned known-good control email. SmartDelivery's
schedule endpoint rejects a custom `sequence` body, so the shell sequence
is the email that actually sends.

Sitters (off-week client A/B and generic sit) are members of **that shell
only** — not live campaigns. Sending pods are also members of the shell so
their known-good tests can run; they stay on their live client campaigns
too. Do **not** hang pod controls on a live client campaign.

Health, top-up, fan-out, rest, scanner Auto: tests, bounce-investigate, and
copy-canary never treat the shell as a production campaign. Isolation-domain
and D54 canary fleet mailboxes never join it.

**Why.** Josh (2026-08-23): paused shell is the path. Sitters are off live
campaigns, and SmartDelivery will only test senders that are already
campaign members.

**Tradeoff.** Sending mailboxes sit on live + the paused shell. Accepted:
the shell never sends to leads.

**Guards.** `isPodControlShellCampaign` / `isExcluded`; owner-intent D56;
pod controls refuse a first-ACTIVE fallback.

## D58 — Generics only on Goliath; floor is half the client's inboxes

**Decision.** Pull every generic off every campaign except **Goliath**.
Goliath may keep and still receive generics. Everyone else is staffed
from that client's own inboxes only.

The live staffable floor is **half of that client's total client
inboxes** (A+B, sitting included), not the old global 50 (D7). Vasco
has 80 client inboxes → 40 per campaign. Odd counts round down.

D26 fan-out still puts client inboxes on every ACTIVE campaign for that
client. Fan-out must not put generics back on a non-Goliath campaign.
The paused pod-control shell is not a live campaign and keeps its
members (D56).

**Why.** Josh (2026-08-24): 300 generics sending was too high. Keep them
on Goliath only and drop the floor to half of each client's own boxes.

**Tradeoff.** Non-Goliath campaigns shrink to the on-week client cohort
plus any leftover client boxes. Shortfalls Slack; they are not filled
with pool generics.

**Guards.** `clientInboxStaffFloor(80) === 40`; `allowsGenericStaff`
matches Goliath; top-up pulls and will not restaff non-Goliath;
owner-intent D58. The D7 default of 50 stays in config as a leftover
number and is not the live floor.

## D59 — Wipe leftover unhealthy marks; B-pod is the sending half

**Decision.** Every leftover “unhealthy” mark is deleted. That includes
`heldInboxes`, HOLD-UNTIL tags, mailbox-control kill/watch tags, held
placement-test records, inbox-remediation dedupe keys, active recovery
swaps, and old same-ESP scores on client rest records.

Nothing is unhealthy until the **new** rules mark it (D51 kill-only
readings, D58 Goliath-only generics). D43 A/B sit is not a hold: this
fortnight **B sends**, A sits. Every on-week client inbox goes on every
ACTIVE campaign for that client — half of that client’s own inboxes,
which is also the D58 floor.

Client rest must not skip or veto a B-pod box because of an old hold or
an old placement score.

**Why.** Josh (2026-08-24): BCP and Parlay looked short because boxes
were still marked unhealthy from the old rules. Start clean.

**Tradeoff.** Real same-ESP fails that D44 kept are released too.
Accepted: the new system has to earn those marks again.

**Guards.** `shouldVetoRestRestore` is always false; `UnhealthyResetService`
wipes holds; on-week restore targets every live client campaign;
owner-intent D59.

## D52 — Tell Josh when a campaign is running out of leads

**Decision.** Watch remaining leads on every ACTIVE campaign. Slack at
**half consumed**, **three quarters**, and **done**. Say it in plain
English with leads left and recent send rate so the remaining days are
obvious. Never import leads or extend a campaign. Tell Josh and wait.

A campaign that is **working** (reply / positive-reply data already on
hand) and running low is urgent. A campaign that is **not getting
replies** and running low is not urgent — say do not top it up; that
would throw good leads after a campaign that is not working.

Campaign audit watches **sender headcount and placement-test cover**.
Send volume watches **today's sent count**. Neither watches remaining
leads. Do not add this number to those two reports — one watcher, one
Slack.

**Why.** Josh (2026-08-23): a working campaign that quietly empties is
the most expensive failure. Warmup and list-building take time, so
finding out the day it empties is already too late.

**Tradeoff.** One statistics + analytics call per ACTIVE campaign on the
monitor pass. Accepted: the alternative is discovering an empty list by
hand.

**Guards.** `enableLeadRunout` default true; `formatRunoutMessage` never
imports; owner-intent D52.

---

## D53 — Sending-infrastructure census from placement reports

**Decision.** Before spending on an add-on that claims a reply lift from
"better sending IPs", read what our mailboxes actually send from. Use
SmartDelivery IP analytics, rDNS, and IP blacklist on the placement
tests we already run. Do not buy a new data source.

For each sending IP: address, geography, who owns the range, whether it
is listed. Slack a straight summary: reputable ranges in the right
region, or not. Good → drop the add-on. Bad → bigger than the add-on;
say so immediately. Never spend from this path.

**Why.** Josh (2026-08-23): the same vendor has complaints about serving
traffic from IP ranges that do not match where customers sell. If we are
already on good infrastructure the add-on buys nothing.

**Tradeoff.** First census after deploy posts once. A bad reading pages
again at most weekly. Parser is defensive because SmartDelivery payload
shapes vary.

**Guards.** `enableSendingInfraCensus` default true; owner-intent D53;
no spend from the census service.

## D60 — Ask once for the canary fleet; then wait

**Decision.** Slack **Buy the unwarmed canary fleet** once. After Josh
taps, or while nameservers / InboxKit / Smartlead export are still
catching up, do not ask again. Do not open a second pending buy. Do not
wipe the domains already bought. A second tap is “already done.”

Empty inboxes are not “not bought.” They mean wait. Health resumes the
mailbox wait. Deploy remind does not re-post that button once a buy is
approved or executed.

**Why.** Josh (2026-08-24): the wizard kept prompting to buy the fleet
after the domains were already purchased.

**Tradeoff.** If the first Slack is missed, Josh has to ask in chat or
hit `/ops`. Accepted: a second buy prompt is how we almost bought twice.

**Guards.** `canaryFleetBuyAlreadyOpen`; attach restores domains from the
executed action; owner-intent D60.

## D61 — Vasco to 40; wipe GXA / MSRS / Nieto

**Decision.** Vasco keeps **40** client inboxes — the same Google /
Microsoft mix it has now. Prefer boxes already on live campaigns. The
other Vasco inboxes come off Smartlead and InboxKit. Vasco does **not**
A/B-sit after this; all 40 send. The live floor for Vasco is 40, not 20.

GXA, MSRS, and Nieto inboxes are wiped from Smartlead and InboxKit —
accounts deleted, matching InboxKit mailboxes cancelled, domains purged
when nothing else still uses them. Pool generics, pre-warmed fleets, and
the canary fleet are not touched.

**Why.** Josh (2026-08-24): Vasco's TAM is too small for 80. GXA, MSRS,
and Nieto should be totally gone from InboxKit and Smartlead.

**Tradeoff.** Destructive and one-shot. A mis-named client would be
skipped rather than guessed. Retry if InboxKit errors; 404s on already
deleted Smartlead accounts are not errors.

**Guards.** `vascoKeepCount === 40`; wipe patterns gxa/msrs/nieto;
`ClientWipeService`; Vasco is a full-send client; owner-intent D61.

## D63 — Campaigns are not short of generics

**Decision.** Do not tell anyone a campaign is short because there are
not enough warmed spares. Non-Goliath campaigns are client-inbox only
(D58). The generic pile is large and stays on Goliath. Slack must say
the campaign is missing this client's own on-week inboxes, or stay
quiet. A leftover / unknown campaign id on an inbox is not "excluded"
— those inboxes still rest and restore onto the client's live
campaigns. The same unchanged short Slack goes out at most once per
twelve hours.

**Why.** Josh (2026-08-24): "you keep telling me campaigns are short on
senders but its because we dont have enough generics which i dont
believe." Live count: 238 available pool generics, 60 on Goliath, BCP
sending 22 of 44 on-week client boxes. The lie was the Slack line.

**Tradeoff.** Slack is quieter. Missing on-week client boxes still get
restored every health pass; we just stop paging the same wrong reason.

**Guards.** Slack copy has no "not enough warmed spares";
`isExcludedOnlyMembership` ignores unknown campaign ids; owner-intent
D63. The twelve-hour Slack cadence is superseded by D64.

## D64 — Staffing Slack is end of day

**Decision.** Routine campaign-staffing Slack is **once at end of day**,
on the last client-day brief (America/New_York). The 15-minute health
loop still restaffs; it does **not** Slack “still short.” Spend, DNS,
isolation, lead-runout, and a real staffing *action* (added a spare,
resumed a protective pause) may still Slack when they happen.

**Why.** Josh (2026-08-24): "stop spamming me updates every 10 minutes.
those should be end of day updates."

**Tradeoff.** A thin campaign can sit all afternoon before Slack says
so. Health is still putting on-week boxes back every 15 minutes.

**Guards.** Health does not Slack when the only news is still-short;
day brief `endOfDay` includes the staffing picture; owner-intent D64.

## D65 — Retired domains stay off live campaigns

**Decision.** Once Josh retires a sending domain, every inbox on that
domain stays off ACTIVE campaigns. Fan-out, rest restore, and generic
top-up must not put them back. Replacements are new domains; they owe
21 days from InboxKit import and stay off campaigns until warm.
`client_id` is not set on a BCP replacement until it is warm, so the
live floor does not move.

**Why.** Josh (2026-08-24) authorized retiring
`boldercyperpartnerhqs.info` and `hubmeetconnect.com` after same-ESP
known-good Gmail→Gmail scores of 0% (8 seeds, peers 100%). Health
fan-out put Sandy and Ted back on live BCP campaigns within minutes
because retire only pulled membership.

**Tradeoff.** A retired inbox cannot be reused without Josh un-retiring
the domain. Accepted: putting a 0% same-ESP domain back on client send
is worse.

**Guards.** `isRetiredSendingDomain`; fan-out / rest / top-up skip
retired domains; owner-intent D65.

## D69 — Copy Slack is the word and a one-click edit

**Decision.** Do not Slack a placement-split guess that "it's the
copy/offer." Mark the campaign copy-suspect, confirm with canaries,
run the word-deletion tests, then Slack once: it was this word, here
is the suggested edit, make the changes? The button applies that one
edit. Missing isolation rig or a hunt that recovers nothing may still
Slack — those are blockers, not guesses.

**Why.** Josh (2026-08-25) pasted the BCP Healthcare Over-1k Slack
("Outlook/Microsoft is mostly spam while Gmail is healthier — usually
the copy/offer") and said it is not helpful. The hunt already existed;
the guess fired first and the button waited.

**Tradeoff.** Josh will not see a copy alert until the word hunt
finishes. Accepted: a guess without a word is noise.

**Guards.** Remediation / bounce-investigate do not Slack copy_likely
reasons; isolation is silent on COPY until the swap button; owner-intent
D69.

## D71 — Slack is burned domain, isolated word, and EOD sends/spam

**Decision.** Slack posts only three things:

1. A **burned domain** with receipts and a button to cancel / replace
   (`retire_domain` / `buy_domains`).
2. A **spam word or phrase** that isolation actually recovered, with
   Make the changes (`swap_copy`).
3. The **end-of-day client scoreboard**: each client, total sends, spam
   rate. Once. America/New_York last send-volume slot.

Health, rest, fan-out, top-up, reconnect, DNS, lead-runout, placement
guesses, pod/cohort chatter, midday briefs, and staffing ticks stay in
logs and `/ops`. The 15-minute loop still restaffs. It does not talk.

This supersedes D64's Slack exceptions (spend / DNS / lead-runout /
staffing-action may Slack) and D69's "missing rig may still Slack."
The hunt still runs; it only Slacks when it has the word and the
button. Spend stays on `/approvals` (D4). Button tap results may Slack
so Josh sees the retire / swap / buy finished.

**Why.** Josh (2026-08-25): "i literally only want these things coming
into slack... the updates i keep getting every 15 minutes are
worthless. this is supposed to run in the background and flag me when
there is a deliverability issue, not to let me know im on pod b for
the 80th time." Client rest was Slacking "group B is sending" every
time health restored an on-week box.

**Tradeoff.** A thin campaign, a DNS miss, or a canary-fleet buy ask
will not page Slack. Accepted: those are `/ops` and logs.

**Guards.** `slackAllowed` is only burned_domain / copy_word /
eod_summary / action_result; client-rest does not Slack the fortnight;
EOD brief has sent + spam and no staffing; owner-intent D71.

## D74 — QA must catch a foreign-client signature

**Decision.** A live campaign must not send another client's brand in
the mailbox signature or in the sequence. Campaign audit is the QA
scan: it flags a mailbox whose from-name / signature carries a
different known client, a step missing `%signature%`, or copy that
hardcodes another client's brand. Health rewrites a foreign-brand
signature on the 15-minute gap pass — do not wait six hours.

D31 still formats signatures as two-line Name / Brand and still
preserves a richer *same-client* brand line (Mid-South Roof Systems
vs MSRS). It does **not** preserve a leftover other-client line.
The sending brand is the ACTIVE campaign's client, not a stale
mailbox `client_id`.

This does not Slack (D71). It logs `[campaign-audit] SIG-MISMATCH`.

**Why.** Josh (2026-08-25): a Goliath email went out with
`Sean, that offer's still open whenever you want it` and the
signature `Aarav Sanchez / Roofs by Peterson`. "you should have
caught this in your QA scans, sigs is part of it." Campaign audit
only counted senders and placement tests. Signature converge
preferred the existing second line, so a Peterson leftover on a
Goliath generic was treated as correct.

**Tradeoff.** A mailbox on two clients' ACTIVE campaigns (D26
forbidden) is logged, not rewritten. Accepted: that is a membership
bug, not a signature guess.

**Guards.** `findForeignBrand`; `desiredMailboxSignature` drops a
foreign second line; campaign-audit SIG-MISMATCH; gap enforce
rewrites foreign sigs; owner-intent D74.

## D75 — One inbox, one client, hard cleanup every health pass

**Decision.** An inbox may sit on every campaign for **one** client
and on the paused pod-control shell. It may not sit on another
client's campaigns at the same time. Health pulls those foreign
memberships every 15 minutes, then sets the signature to the owner
client's brand.

Owner is `mailbox.client_id`. The shell does not count. Isolation
and canary-fleet mailboxes are skipped. Same-client fan-out (D26)
is unchanged.

This supersedes D74's "two-client membership is logged, not
rewritten."

**Why.** Josh (2026-08-25): change the leftover Peterson signature
on the Goliath send, and "hard rule of an inbox can only be
assocoated wiht one clients cmpaigns at a time." D26 already said
that; nothing stripped existing cross-client memberships, so a
generic could send Goliath with a Peterson line.

**Tradeoff.** Pulling a mailbox off the wrong client can thin that
campaign until top-up refills. Accepted: the wrong-brand send is
worse.

**Guards.** `foreignCampaignIds`; `OneClientMembershipService`;
owner-intent D75.

---

## D76 — Generics belong to Goliath even with a leftover client_id

**Decision.** A pool or extra-fleet generic is owned by Goliath
(D58) even when `mailbox.client_id` still names another client, or
is empty. Health treats Goliath as the owner: pulls every other
client's campaigns, sets `client_id` + signature to Goliath, and if
the generic is sitting on a foreign client with no Goliath
campaign, puts it back on every **ACTIVE** Goliath campaign
(stopped L1–L4 and the shell stay untouched).

Pool-plan domains (`getoutreachdesk.info` and the rest of
`GENERIC_POOL_PLAN`) count as generic without needing the local
pool file.

This supersedes D75's "Owner is `mailbox.client_id`" for generics
only. Real client inboxes still use `mailbox.client_id`.

**Why.** Josh (2026-08-25): change the leftover Peterson signature,
and one inbox / one client's campaigns. Aarav Sanchez at
`getoutreachdesk.info` is a pool generic that still had Peterson's
`client_id`. Treating that id as owner pulled the box off Goliath
instead of rewriting the sig.

**Tradeoff.** A generic that was parked on another client before
D58 comes back to Goliath. Accepted: D58 already forbids
non-Goliath generic staff.

**Guards.** `ownerClientId` generic override; `isGenericPoolDomain`;
`OneClientMembershipService` restore; owner-intent D76.

---

## D77 — Campaigns carry a client tag; unpause after signature QA

**Decision.** Every campaign is assigned a Smartlead client
(`client_id` — the client tag). Health fills a missing tag from a
unique name match. Signature QA matches senders to that assigned
client, not a guess from the campaign title.

After a passing QA (no leftover other-client brand on any sender),
a **PAUSED Goliath** campaign is STARTed. The pod-control shell,
STOPPED L1–L4, DRAFTED campaigns, and non-Goliath manual pauses
stay down (D40 / D56).

**Why.** Josh (2026-08-25): after a QA pass knows sigs match the
client, unpause. "Client matching should be easy — every campaign
gets a client tag assigned."

**Tradeoff.** A Goliath campaign Josh paused by hand will come back
once signatures are clean. Accepted: the leftover Peterson send was
the reason those were down. STOPPED still means operator takeover.

**Guards.** `matchClientForCampaign`; `CampaignClientTagService`;
`UnpauseAfterSigQaService`; owner-intent D77.

