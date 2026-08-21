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

> That reverses D1 — a mailbox owes 14 days from its InboxKit import before
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

`EXTRA_GENERIC_DOMAINS` is authoritative for those fleets: every mailbox on
`crosslaunchco.com`, `crossscaleco.com`, and `cleartechco.com` is pre-warmed.
Do not rely on exact from-name spelling or Smartlead's reported warmup start;
those have already caused live pre-warmed senders to be pulled.

## Sender identity

**One client per sender — not one campaign.** A mailbox (client domain or
generic) may sit on **every ACTIVE campaign for that same client**, except
when it is in its off-week rest (D41 qualifies D26). BCP
mailboxes go on all BCP campaigns; Parlay on all Parlay; etc. (`ClientFanOutService`,
D26). Cross-client membership is still forbidden.

Generics may staff **any** client including BCP (D27). On assign, signature /
from-name / client id are set to the receiving client.

**Cross-client top-up is still a move** (remove from the other client, add to
the receiver). **Same-client** top-up/fan-out is additive — keep the mailbox
on the other campaigns for that client.

Warmup stays **on for every mailbox** (mailbox-settings converge).

## Rotation thresholds

A sender comes off active campaigns when either signal fails:

- **Placement** below `REMEDIATION_INBOX_THRESHOLD` (80%) on the **same-ESP**
 score only (D32). Never use the blended / all-ESP SmartDelivery score to
 pull a mailbox. Thin same-ESP samples ⇒ skip placement rotation that run.
- **Bounce** above `BOUNCE_RATE_THRESHOLD` (5%), once it has sent at least
 `MIN_BOUNCE_SAMPLE` (50). These are independent — seed inboxes accept mail,
 so a mailbox can hold a clean inbox rate while bouncing hard against real
 leads. Slack warns at `BOUNCE_RATE_WARN_THRESHOLD` (2%) without pulling (D41).

Both route through the same path: removed from active campaigns, warmup
re-enabled, `HOLD-UNTIL` tag, held `RECOVERY_HOLD_DAYS` (14), and a warmed
generic swapped in — **unless** placement says the weakness is copy/offer
driven (Outlook buried, Gmail fine): then Slack to test the copy and do not
bench those senders (D28).

If a campaign is **PAUSED** with aggregate sender bounce over **7%**,
investigate: copy_likely → Slack only; otherwise rotate worst bouncers
(D29). Do **not** auto-`START` — a manual pause stays paused (D40). Only
protective pauses recorded in `pendingResumes` may be resumed by health,
and never when the campaign is **STOPPED**.

Campaigns are topped up to `MIN_CAMPAIGN_SENDERS` (50) **staffable** senders
from the pool — connected SMTP/IMAP, not held, and not resting. Disconnected membership
does not count (D25). Health also runs same-client fan-out and client rest (D41). `CRON_HEALTH`
every 15m; Measure on the slower monitor.
`TOP_UP_EXCLUDE_CAMPAIGNS` holds ids or name fragments to leave alone —
currently the MSRS, HVAC and Roofers campaigns, listed by exact id so a
future campaign with a similar name is not skipped by accident.

## When setting up a campaign

Follow these rails (same text lives in `campaignSetupPrompt()` and `/ops`):

1. Staffing floor is 50 *staffable* senders (connected SMTP/IMAP, not held, not resting). Generics fill the gap. Do not buy a third client-domain set.
2. Client inboxes rest 2 weeks on / 2 weeks off. Off-week boxes come OFF live campaigns (warmup stays on). Do not leave resters on a campaign at `MESSAGE_PER_DAY=0`.
3. Same-client fan-out still applies for *on-week* client inboxes only. A resting mailbox must not be added to every ACTIVE campaign for that client.
4. New campaigns (`created_at` last 7 days) are canaries: attach only ~15% of on-week client inboxes. Generics may still top up to 50. If 3+ unrelated sending domains drop on same-ESP, pause *that* campaign only — do not auto-START it.
5. Fresh (non-prewarmed) InboxKit mailboxes owe 21 days before live send. Pre-warmed fleets (`crosslaunchco.com`, `crossscaleco.com`, `cleartechco.com`) skip that wait. Pool warmup stays 14 days.
6. Every mailbox: 30 campaign emails/day (warmups not included), 10-minute gap, warmup ON, plain Name / Brand signature.
7. Placement tests are one recurring SmartDelivery schedule per campaign (`every_days: 1`), not a new test each morning. Quota is 120.
8. Never auto-resume a campaign someone paused or stopped by hand. Protective pauses we took stay in `pendingResumes` only.
9. Do not spend, purge, or bypass warmup/holds from chat. Approvals stay on.
10. After launch: health (15m) will rest, top-up, and fan-out. Watch Slack on / off / generic-spare piles and `[client-rest]` / `[health]` logs.

## Held mailbox placement tests (D39)

Mailboxes pulled off campaigns (HOLD) get **separate** SmartDelivery recurring
tests — not re-attached to live campaigns. Slack day briefs are per-client
(sent / bounce% / spam% + on / off / generic-spare / held counts), not per-mailbox lists.

## Client inbox rest (D41)

Client inboxes (not pre-warmed fleet domains / pool generics) work **2 weeks
on / 2 weeks off**. Off-week they are removed from live campaigns; warmup stays
on. Resting is not staffable. Generics are the spare tire and do not rest.
New campaigns (`created_at` last 7 days) get ~15% of on-week client inboxes;
3+ unrelated domains dropping same-ESP pauses that campaign only (no auto-START).
Fresh (non-prewarmed) inboxes owe **21** days before live campaigns;
`POOL_WARMUP_DAYS` stays 14. Blacklist alone does not burn a domain.

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

`TOTAL_TEST_QUOTA` (120) is checked before creating; the scanner blocks and
alerts rather than exceeding it. The reconciler stops a recurring test when its
campaign goes inactive, freeing the slot.

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

An unchanged critical domain/issue combination alerts at most once every seven
days. A different issue remains immediately alertable.

## Warmup exemption mechanisms

They are not equivalent:

- `WARMUP-GATE-EXEMPT` tag (Smartlead, per mailbox) — skips **both** the
  under-warmed and `HOLD-UNTIL` checks
- `EXTRA_GENERIC_MAILBOXES` (env, by name) — skips the pre-warmed check only
- `EXTRA_GENERIC_DOMAINS` (env, whole dedicated fleet) — skips the pre-warmed
  check only and is authoritative for known pre-warmed fleet domains

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
