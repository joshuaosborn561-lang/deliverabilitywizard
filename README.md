# Deliverability Wizard

Internal service that staffs Smartlead campaigns, rotates senders, and keeps
SmartDelivery placement tests running. Railway watches `main`
(`deliverabilitywizard` / production).

Two people drive this repo: **Josh** owns product calls (`DECISIONS.md`);
**Cayden** contributes alongside him. See [CONTRIBUTING.md](CONTRIBUTING.md).

## How senders rotate

Health runs every **15 minutes**. That is the live loop.

**Client inboxes (D43).** Each client is split evenly A/B. The off-week half
comes **off** live campaigns; warmup stays on. Resting boxes are not staffable
and do not fan out. The on-week half stays on every ACTIVE campaign for that
same client.

**Generics — the queue, not the client fortnight.** A generic sends for
**~14 days**, sits for the same stretch, then is supply again. The clock starts
when we first see it on an ACTIVE campaign (or from pool `assignedAt`). Sit is
**staggered per mailbox**, so half the spare tire does not vanish the morning
clients rest.

**Top-up.** Every live campaign is filled to **50 staffable** senders
(connected SMTP/IMAP, not held, not resting) with at least **~30% Google and
~30% Microsoft**. Generics may staff any client, including BCP.

**Holds (D44).** First health after deploy rebuilds the hold pile once: keep
only **same-ESP** fails below 80%. Unproven HOLDs go back into D43. Going
forward, only proven-weak senders are pulled — same-ESP inbox below 80%, or
bounce above 5% with at least 50 sends. Copy/offer (Outlook buried, Gmail fine)
is Slack only; those senders stay up.

**Left alone.** MSRS, HVAC, and Roofers (`TOP_UP_EXCLUDE_CAMPAIGNS`, exact
ids). A pause someone made by hand is never auto-`START`ed.

## Placement tests

One **recurring** SmartDelivery schedule per campaign (`every_days: 1`). The
count does not grow each morning. Held mailboxes and off-week **client**
inboxes get their own tests (not re-attached to live campaigns). The
reconciler stops a test when its campaign is no longer active.

**No 120 plan quota.** Josh has unlimited SmartDelivery tests. Default
`TOTAL_TEST_QUOTA=0` means unlimited (D45). A positive value still caps and
blocks. **≤50 senders per test** is a SmartDelivery API limit, not a plan
quota.

**Launch bar is 85% same-ESP** (promo tab = miss, D46). 80% same-ESP and
5% bounce are **readings only** (D51) — they do not pull a live mailbox.
The only automatic live pull is Josh killing a mailbox / retiring a domain.

Idle or zero-lead ACTIVE campaigns still get a daily test unless we skip them
— that matters more with the cap gone.

## What else runs

| Loop | When | What |
|------|------|------|
| Health | every 15m | Rest, generic sit, top-up, fan-out, hold rebuild once, gap/settings |
| Scan | Mon & Thu 09:00 UTC | Create recurring tests for live campaigns that lack one |
| Monitor | every 6h | Placement scores, DNS audit (advisory), blacklist, Slack day brief |
| Reconnect | 3am ET + every monitor + boot | Reauth failed SMTP/IMAP; retry InboxKit exports |
| Pool provisioner | every 30m | Buy → export → 14-day warmup for managed generics (spend-gated) |

Mailbox settings converge to 30 campaign emails/day (warmups not included),
10-minute gap, warmup on, and a plain `Name / Brand` signature.

Manual trigger: `POST /run?mode=scan|monitor|remediate|pool|reconnect|warmup-gate|health|all`.

## Blacklist diagnosis

Not every hit means a domain is burned. Monitor separates them:

| Verdict | Signal | Action |
|---------|--------|--------|
| `domain_burned` | The sending domain itself is listed | Replace — remediation handles it |
| `shared_ip` | Domain clean; IP listed and shared with our other domains | Take the IP to InboxKit; do not replace domains |
| `domain_ip` | Domain clean, IP listed, no other domain behind it | Confirm with InboxKit |
| `unclear` | Report didn't say | Check before replacing |

Only `domain_burned` is eligible for automatic replacement.

## Generic recovery pool

Managed plan plus pre-warmed fleets on `crosslaunchco.com`,
`crossscaleco.com`, and `cleartechco.com` (`EXTRA_GENERIC_DOMAINS`). Those
fleets arrive pre-warmed and owe no import warmup. Fresh (non-prewarmed)
InboxKit mailboxes owe **21 days** from import before live send (D50).

With `ENABLE_POOL_PROVISIONER=true`, cron self-advances
`awaiting_ns` → `buying` → `awaiting_mailboxes` → `awaiting_sequencer` →
`exporting` → `awaiting_export` → `warming` → `ready`. Slack only on phase
changes. Purchases still go through `/approvals`.

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness + last run timestamps |
| `GET` | `/status` | Full state + effective config (requires `X-Run-Token`) |
| `POST` | `/run` | Manual trigger |
| `GET` | `/approvals` | Token-authenticated read-only approval listing |
| `GET` | `/ops` | Employee console |

`/status`, `/run`, and `/approvals/*` stay disabled when `RUN_TOKEN` is unset.
`/health` is the only unauthenticated operational endpoint.

## Employee operations UI

Private console at **`/ops`**. Josh (`owner`) and Cayden (`operator`) have
separate signed sessions.

Cayden may check placement/campaigns/DNS, reconnect mailboxes, and confirm
one-mailbox rotations when every runtime precondition passes. Spending,
approval decisions, destructive teardown, safety-policy changes, bulk
remediation, and production deploy stay with Josh.

Required Railway variables: `OPS_UI_ENABLED`, independent owner/operator
usernames and tokens, and `OPS_SESSION_SECRET`. Do not reuse `RUN_TOKEN`
for login.

`railway.toml` pins **one replica**. Do not scale without a shared lock.

## Spend approval

`REQUIRE_SPEND_APPROVAL` stays **on**. Real-money spend is held for human
approval via `/ops` → Approvals. Approvals are single-use. Client-scoped
spend must carry the $25 domain / 25 mailbox monthly-cap metadata.

`DRY_RUN=true` skips buying entirely (no approval request is created).

## Environment variables

Copy `.env.example`. Required: `SMARTLEAD_API_KEY` and Slack
(`SLACK_WEBHOOK_URL`, or bot token + channel).

| Variable | Default | Description |
|----------|---------|-------------|
| `TOTAL_TEST_QUOTA` | `0` | Concurrent SmartDelivery test cap. **0 = unlimited**. Do not set Railway to 0 until this code is on `main` — older deploys reject 0. After merge, delete the var or set `0`. |
| `MAX_MAILBOXES_PER_TEST` | `50` | SmartDelivery API limit per test |
| `AUTO_PLACEMENT_TESTS` | `true` | Recurring daily tests while the campaign is live |
| `PLACEMENT_TEST_EVERY_DAYS` | `1` | Recurrence interval |
| `ENABLE_TEST_RECONCILER` | `true` | Stop tests whose campaign went inactive |
| `REMEDIATION_INBOX_THRESHOLD` | `80` | Pull on same-ESP inbox below this % |
| `MIN_CAMPAIGN_SENDERS` | `50` | Staffable-sender floor |
| `CRON_HEALTH` | `*/15 * * * *` | Rest / sit / top-up / fan-out |
| `CRON_MONITOR` | `0 */6 * * *` | Placement / DNS / Slack brief |
| `CRON_SCAN` | `0 9 * * 1,4` | New-campaign test create |
| `ENABLE_CLIENT_REST` | `true` | Per-client A/B fortnight |
| `ENABLE_GENERIC_SEND_REST` | `true` | Generic 14-day send clock |
| `GENERIC_SEND_REST_DAYS` | `14` | Days of live send before a generic sits |
| `ENABLE_REST_BASELINE_REBUILD` | `true` | One-shot unproven-HOLD release |
| `CAMPAIGN_ESP_MIX_MIN_PERCENT` | `30` | Min Google / Microsoft share on top-up |
| `MESSAGE_PER_DAY` | `30` | Campaign send cap (warmups not included) |
| `MAILBOX_MIN_TIME_GAP_MINS` | `10` | Minimum time gap |
| `POOL_WARMUP_DAYS` | `21` | Import warmup for managed generics |
| `EXTRA_GENERIC_DOMAINS` | `crosslaunchco.com,crossscaleco.com,cleartechco.com` | Pre-warmed fleets |
| `REQUIRE_SPEND_APPROVAL` | `true` | Hold real-money spend for `/approvals` |
| `RUN_TOKEN` | _(empty)_ | Required to enable `/status`, `/run`, `/approvals/*` |
| `DRY_RUN` | `false` | Plan writes without applying; skips pool buys |

**Do not hardcode secrets.** Set them as Railway service variables.

## Local development

```bash
cp .env.example .env
# fill in SMARTLEAD_API_KEY + Slack
npm install
npm run typecheck && npm test
npm run dev
```

## Railway deploy

1. Attach a volume at `/data` (`STATE_FILE_PATH=/data/state.json`).
2. Set the variables above as Railway secrets.
3. Deploy from `main`. Health check: `GET /health`.

After this D45 code is on `main`, **delete `TOTAL_TEST_QUOTA` or set it to
`0`**. Leaving `120` keeps the old cap even though the default is unlimited.
Do not set `0` on the currently deployed (pre-D45) code — that crash-loops.

## Tracking

State file plus SmartDelivery's existing test list so the same campaign is
not given a second recurring schedule across restarts.
