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

**When Josh makes a new call in a session, append it to `DECISIONS.md` in that
same session, with its guard.** Chat history is not durable; the repo is.

Work on your own branch and merge through a PR — never push to another
person's branch.

**`cursor/generic-pool-expand-240-2606` is the deploying branch.** Railway
watches it, so a push there is a production deploy. Each push restarts the
app, which resets the cron cycle — avoid pushing in a tight sequence when you
need a scheduled job to actually run.

## Warmup and the mailbox pool

**Warmup is owed from the InboxKit import, not from Smartlead's warmup
record.** A mailbox bought from InboxKit is cold on arrival however long
Smartlead's `warmup_details.created_at` claims warmup has existed. The pool
stamps `warmedAt` at import and the mailbox owes a full `POOL_WARMUP_DAYS`
(14) before it may enter a live campaign.

This was implemented the other way round once. It moved 74 clocks earlier and
would have rotated cold mailboxes into client campaigns. Do not re-derive it
from Smartlead's data.

`EXTRA_GENERIC_MAILBOXES` holds **from-names carried by a whole fleet**, not
individuals. "harmony norris" is the sender identity on ~100 mailboxes at
crosslaunchco.com; "breanna escobar" on ~100 at crossscaleco.com. Every
account matching at or above the match threshold is registered — matching only
the best one stranded 198 pre-warmed generics. These arrive pre-warmed and are
registered `available` immediately; they owe no warmup.

## Sender identity

**Never move a client-branded sender between campaigns.** Senders carry brand
through their domain — Parlay campaigns send from `parlaytech*.info`,
CultureFits from `culturefits*.info`. One client's domain sending another
client's offer misrepresents both.

Fill thin campaigns from the **generic pool only**. Generics carry no brand of
their own, so signature, from-name and client id are set to the receiving
client on assign, and cleared on swap-back.

## Rotation thresholds

A sender comes off active campaigns when either signal fails:

- **Placement** below `REMEDIATION_INBOX_THRESHOLD` (80%)
- **Bounce** above `BOUNCE_RATE_THRESHOLD` (5%), once it has sent at least
  `MIN_BOUNCE_SAMPLE` (50). These are independent — seed inboxes accept mail,
  so a mailbox can hold a clean inbox rate while bouncing hard against real
  leads.

Both route through the same path: removed from active campaigns, warmup
re-enabled, `HOLD-UNTIL` tag, held `RECOVERY_HOLD_DAYS` (14), and a warmed
generic swapped in.

Campaigns are topped up to `MIN_CAMPAIGN_SENDERS` (30) from the pool.
`TOP_UP_EXCLUDE_CAMPAIGNS` holds ids or name fragments to leave alone.

## Placement tests

Tests are **recurring, not new-daily**: `POST /spam-test/schedule` with
`every_days: 1` creates one parent test per campaign that SmartDelivery
re-runs itself. The count does not grow daily and nothing needs deleting each
morning.

`TOTAL_TEST_QUOTA` (120) is checked before creating; the scanner blocks and
alerts rather than exceeding it. The reconciler stops a recurring test when its
campaign goes inactive, freeing the slot.

## Spend

`REQUIRE_SPEND_APPROVAL` stays **on**. Real-money spend is held for human
approval via `/approvals`. Do not disable it to make an automation smoother.

## DNS

Sending-domain DNS is audited every monitor pass against public resolvers, not
any provider's status field. Missing SPF, duplicate SPF (RFC 7208 permerror)
and unresolvable domains alert; a neutral `?all`, missing DMARC and missing MX
are reported without paging.

The audit is **advisory and does not write DNS**. Pool zones live in InboxKit's
Cloudflare account; the only lever that rebuilds one changes nameservers on
domains that are actively sending.

## Two exemption mechanisms exist

Both skip the warmup gate, and they are not equivalent:

- `WARMUP-GATE-EXEMPT` tag (Smartlead, per mailbox) — skips **both** the
  under-warmed and `HOLD-UNTIL` checks
- `EXTRA_GENERIC_MAILBOXES` (env, by name) — skips the pre-warmed check only

Pick one deliberately. They have not been consolidated.

## Before changing behaviour

- `npm run typecheck && npm test` must pass
- `DECISIONS.md` is append-only — supersede by adding an entry, never by
  editing or deleting one
- Production truth comes from Railway logs, not assumption — the census,
  `[dns-audit]`, `[campaign-audit]` and `[top-up]` lines exist so state can be
  read rather than guessed
- Railway variable *values* are not readable over the OAuth connection; names
  are. Deploy code that logs what you need instead of guessing at config
