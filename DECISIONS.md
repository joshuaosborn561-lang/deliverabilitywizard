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

## D19 — Pre-warmed fleets are identified by domain and persisted state

**Decision.** Every mailbox on `crosslaunchco.com` and `crossscaleco.com` is
pre-warmed. The warmup gate exempts those domains and any pool row marked
`prewarmed`; fuzzy name matching is only an additional fallback.

**Why.** Smartlead reported a recent warmup timestamp and variant identity
`Brianna Escobar` for 12 `crossscaleco.com` mailboxes. Exact matching against
`breanna escobar` failed, so the warmup gate incorrectly removed all 12 from
TechEvo despite the fleet having been bought pre-warmed.

**Tradeoff.** A future cold mailbox added to either explicit fleet domain would
also be treated as pre-warmed. Accepted: those domains are dedicated,
operator-managed pre-warmed inventory.

**Guard.** `warmupGate helpers — explicit pre-warmed fleet domain`
