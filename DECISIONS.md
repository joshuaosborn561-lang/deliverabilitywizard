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
