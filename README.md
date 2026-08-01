# Deliverability Wizard

Internal automation service that finds new Smartlead campaigns and automatically creates SmartDelivery placement tests — no manual setup each time.

## What it does

1. **Twice a week** (Mon & Thu 09:00 UTC by default) scans Smartlead for campaigns that do not already have a placement test.
2. For each eligible campaign, pulls **sender mailboxes** and **email sequence/copy**.
3. Creates SmartDelivery **recurring (automated) placement tests** that re-run **daily** (`PLACEMENT_TEST_EVERY_DAYS`, default 1) for as long as the campaign stays active, so inbox rate is trackable day over day — with:
   - `spam_filters: ["spam_assassin"]` explicitly set
   - `link_checker: true` explicitly set
   - mailboxes split into batches of **≤ 50** senders per test

   Set `AUTO_PLACEMENT_TESTS=false` to go back to one-off manual tests.
3b. **Stops** a recurring test as soon as its campaign is no longer active (runs with the monitor cron), so paused/stopped campaigns don't keep burning test runs.
4. Before creating anything, checks **total test usage vs a 120-test quota**. If the full batch would exceed the quota, **nothing is created** and Slack is notified so you can prioritize or wait.
5. On a separate schedule (every 6 hours by default), monitors results and Slack-alerts with:
   - overall **inbox / tab / spam** split and per-provider breakdown
   - **per-sender placement**, worst first, and what will be done about each
   - **SPF/DKIM failures** — flagged loudly, since failing auth sinks placement regardless of copy or warmup
   - **blacklist diagnosis** that distinguishes a **burned domain** from a **shared InboxKit IP** (see below)

### Blacklist diagnosis

Not every blacklist hit means a domain is burned. The monitor separates them by checking whether one listed IP carries several of our sending domains:

| Verdict | Signal | Action |
|---------|--------|--------|
| `domain_burned` | The sending domain itself is listed | Replace the domain — remediation handles it |
| `shared_ip` | Domain is clean; its IP is listed **and** shared with our other domains | **Do not replace domains** — take the IP to InboxKit |
| `domain_ip` | Domain clean, its IP listed, no other domain behind it | Confirm with InboxKit whether the IP is dedicated |
| `unclear` | Report didn't say | Check manually before replacing |

Only `domain_burned` is eligible for automatic replacement, so a bad shared IP can't trigger a round of pointless domain buying.
6. When `ENABLE_REMEDIATION=true`, automatically remediates:
   - **Blacklisted sending domains** → delete matching Smartlead email accounts and purge the domain from InboxKit
   - **Inboxes under 80%** (not blacklisted) → remove from all ACTIVE campaigns and enable warmup to recover
7. When `ENABLE_RECOVERY_POOL=true` (and pool inventory is in state), swaps a warmed **generic** mailbox (ESP-matched) into those campaigns with signature `First Last\\n{Client Brand}`; when the original recovers ≥80% same-ESP, swaps back and frees the generic.
8. **Daily at 3:00am America/New_York** (`ENABLE_ACCOUNT_RECONNECT=true`), plus **every monitor run (6h)** and on **boot**: polls Smartlead for accounts with failed SMTP/IMAP and calls `/email-accounts/{id}/reauth`. Also re-queues failed InboxKit→Smartlead exports for the generic pool workspace.
9. **Warmup gate** (`ENABLE_WARMUP_GATE=true`, runs with the monitor cron): removes mailboxes from ACTIVE campaigns if they have warmed fewer than **14 days** (configurable) or still carry an active `HOLD-UNTIL-YYYY-MM-DD` tag from remediation. Mailboxes listed in `EXTRA_GENERIC_MAILBOXES` are **exempt** from the under-warmed rule — they are already warm, so Smartlead's warmup start date must not pull them off live campaigns.

Manual trigger is available via `POST /run` (`?mode=scan|monitor|remediate|pool|reconnect|warmup-gate|all`).

## Generic recovery pool (setup)

The managed plan contains 40 domains × 5 mailboxes = 200 (24 Google / 16
Microsoft). The current plan still contains 25 `.info` and 15 `.com` domains.
Two pre-warmed generic fleets (`EXTRA_GENERIC_MAILBOXES`) add roughly 200 more
mailboxes to runtime pool state.

**You do not need to babysit.** With `ENABLE_POOL_PROVISIONER=true` (default), a cron (`CRON_POOL_PROVISION`, every 30m) self-advances:

`awaiting_ns` → `buying` → `awaiting_mailboxes` → `awaiting_sequencer` → `exporting` → `awaiting_export` → `warming` → `ready`

Slack pings only on phase transitions / the one-time Smartlead login need.

One-time requirement for Smartlead export: set `SMARTLEAD_LOGIN_EMAIL` + `SMARTLEAD_LOGIN_PASSWORD` on Railway, **or** connect Smartlead once in InboxKit → DW Generic Pool → Sequencers. After that, cron finishes export + 14-day warmup alone.

Manual kick: `POST /run?mode=pool`.

Restart a stuck pipeline with `POST /run?mode=pool&phase=idle` (valid phases are listed in the error if you pass a bad one). This never spends — any purchase the restarted pipeline wants still has to clear the approval gateway.

Client-scoped spend is hard-capped at **$25 domains / month** and **25
mailboxes / month**. A client spend request without cap metadata is rejected.
Generic-pool replenishment is not client spend and remains separately
single-use approval-gated.

## SmartDelivery access

SmartDelivery lives on `smartdelivery.smartlead.ai` and must be **provisioned by Smartlead support** before the API works. On every scan the app probes access first; if it is not active you will get a Slack message instead of silent failures.

Docs:

- Core API: https://api.smartlead.ai
- Full docs index: https://helpcenter.smartlead.ai/en/articles/125-full-api-documentation
- Create manual placement: https://api.smartlead.ai/reference/create-a-manual-placement

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness + last run timestamps |
| `GET` | `/status` | Full state + effective config (requires `X-Run-Token`) |
| `POST` | `/run` | Manual trigger (`?mode=scan\|monitor\|remediate\|pool\|reconnect\|warmup-gate\|reconcile\|all`) |
| `GET` | `/approvals` | Token-authenticated read-only approval listing |
| `GET` | `/ops` | Employee console; owner approval decisions live here |

Set `RUN_TOKEN` and pass header `X-Run-Token: <token>` for `/status`, `/run`
and `/approvals/*`. Those routes return 503 when no token is configured;
`/health` remains public.

## Employee operations UI

The Railway service hosts a private console at **`/ops`**. It gives Josh
(`owner`) and Cayden (`operator`) separate signed sessions and a chat-style
interface over an explicit operation allowlist.

Allowlisted for Cayden:

- Check placement/deliverability
- Audit campaign sender counts and placement-test coverage
- Audit SPF/DMARC/MX without changing DNS
- Reconnect disconnected Smartlead mailboxes
- Preview and confirm one-mailbox rotations

A manual rotation revalidates immediately before writing: the original must be
on an active, non-excluded campaign; the replacement must be idle, fully warmed
and ESP-matched; active recovery swaps and client-branded cross-client moves
are forbidden. The operation reserves the generic and compensates completed
Smartlead writes if a later step fails.

Chat refuses purchases, deletion/purge, spend decisions, policy/threshold
changes, warmup bypasses, bulk remediation, code changes and deployment. Josh
gets a separate owner-only approval panel. Every console action is persisted
in the bounded audit log.

Required Railway variables:

```text
OPS_UI_ENABLED=true
OPS_OWNER_USERNAME=josh
OPS_OPERATOR_USERNAME=cayden
OPS_OWNER_TOKEN=<independent 32+ character secret>
OPS_OPERATOR_TOKEN=<independent 32+ character secret>
OPS_SESSION_SECRET=<independent 32+ character secret>
OPS_SESSION_HOURS=12
```

Do not reuse `RUN_TOKEN` for either user's login.

Rotation additionally requires `ENABLE_RECOVERY_POOL=true` and warmed,
`available` pool inventory. Otherwise preview fails safely and explains why.

The console and cron mutation locks are process-local. `railway.toml` pins the
US West service to **one replica**; do not scale it without adding a shared
Redis/database lock.

## Spend approval gateway

`REQUIRE_SPEND_APPROVAL` (default `true`) gates every action that spends real money/credits or destroys paid assets:

| Action | Where | Approval key |
|--------|-------|--------------|
| Buy InboxKit mailboxes (`use_wallet_balance: true`) | pool provisioner cron | `pool-auto-{domain}-{platform}-n{n}-v3` |
| Delete mailboxes on a blacklisted domain + purge it from InboxKit (forces re-buying replacements) | remediation | `teardown-domain:{domain}` |

The manual CLI (`scripts/provision-pool-mailboxes.ts`) additionally refuses to buy unless passed `--yes-spend-money`; `--buy` alone only previews.

Two hard safety rails sit underneath the gateway:

- `purgeDomain` **refuses** to run against the generic-pool workspace, so a client-domain purge can never tear down the recovery pool.
- Before cancelling, every mailbox returned by InboxKit's fuzzy `keyword` search is re-checked for an exact domain match, so searching `parlaytech.info` can't cancel `parlaytechnow.info`.

With the gateway on:

1. The pool provisioner computes what it needs to buy, but instead of buying, it records a **pending** spend request (one per domain/platform/count batch) and Slack-notifies with the exact request.
2. Nothing is purchased until Josh approves it from `/ops` → **Approvals**.
3. Once approved, the next `pool` run executes that exact purchase and
   consumes the approval. The same approval can never spend twice.
4. Denying from the owner panel permanently blocks that batch (a changed
   underlying need creates a new request).

`DRY_RUN=true` skips the buying step entirely (no approval request is even created) — use it to see what the provisioner would otherwise ask permission for.

Setting `REQUIRE_SPEND_APPROVAL=false` restores fully unattended spend — not recommended.

## Environment variables

Copy `.env.example`. Required:

| Variable | Description |
|----------|-------------|
| `SMARTLEAD_API_KEY` | Smartlead core API key (`server.smartlead.ai`) |
| `SLACK_WEBHOOK_URL` | Incoming webhook for alerts |

Common optional vars:

| Variable | Default | Description |
|----------|---------|-------------|
| `SMARTDELIVERY_API_KEY` | same as Smartlead key | Use if SmartDelivery uses a separate key |
| `TOTAL_TEST_QUOTA` | `120` | Hard cap before refusing a batch |
| `MAX_MAILBOXES_PER_TEST` | `50` | Split threshold |
| `AUTO_PLACEMENT_TESTS` | `true` | Create recurring tests that keep testing while the campaign is live (`false` = one-off manual) |
| `PLACEMENT_TEST_EVERY_DAYS` | `1` | Recurrence interval — daily, so inbox rate is trackable day over day |
| `PLACEMENT_TEST_END_DAYS` | `0` | Optional hard stop in days; `0` = open-ended |
| `AUTO_TEST_ACTIVE_STATUSES` | `ACTIVE` | Campaign statuses that keep a recurring test alive |
| `ENABLE_TEST_RECONCILER` | `true` | Stop recurring tests whose campaign went inactive |
| `DELIVERABILITY_THRESHOLD` | `90` | Slack when inbox placement is below this % |
| `REMEDIATION_INBOX_THRESHOLD` | `80` | Pull non-blacklisted inboxes below this % for warmup |
| `RECOVERY_HOLD_DAYS` | `14` | Warmup hold (2 weeks) before a pulled inbox may return to campaigns |
| `EXTRA_GENERIC_MAILBOXES` | `harmony norris,breanna escobar` | Pre-warmed generics outside the `.info` plan (matched by email or `from_name`); registered swap-ready and exempt from the warmup gate |
| `EXTRA_GENERIC_DOMAINS` | `crosslaunchco.com,crossscaleco.com` | Explicit whole-domain pre-warmed fleets; authoritative over unreliable Smartlead warmup dates/name variants |
| `ENABLE_REMEDIATION` | `false` | When true, auto-delete blacklisted domains + recover low inboxes |
| `ENABLE_RECOVERY_POOL` | `false` | Swap warmed generics into campaigns while originals recover |
| `POOL_WARMUP_DAYS` | `14` | Days before a pool generic is free for swaps |
| `CLIENT_DOMAIN_BUDGET_USD` | `25` | Porkbun domain $ cap per client / UTC month |
| `CLIENT_MAILBOX_MONTHLY_CAP` | `25` | New mailboxes per client / UTC month |
| `GENERIC_POOL_WORKSPACE_ID` | _(empty)_ | InboxKit workspace for the managed and pre-warmed generics |
| `PORKBUN_API_KEY` / `PORKBUN_SECRET_API_KEY` | _(empty)_ | Domain purchase for replaces |
| `INBOXKIT_API_KEY` | _(empty)_ | Required for InboxKit domain purge |
| `INBOXKIT_WORKSPACE_ID` | _(auto)_ | Optional; resolved from InboxKit workspaces if empty |
| `CRON_SCAN` | `0 9 * * 1,4` | Twice weekly scan |
| `CRON_MONITOR` | `0 */6 * * *` | Results / blacklist / remediation polling |
| `ENABLE_ACCOUNT_RECONNECT` | `true` | Reauth disconnected Smartlead accounts (3am ET + every monitor + boot) |
| `CRON_ACCOUNT_RECONNECT` | `0 3 * * *` | Daily pass in `America/New_York` (also runs with monitor cron) |
| `ENABLE_WARMUP_GATE` | `true` | Strip under-warmed / HOLD mailboxes from ACTIVE campaigns |
| `MIN_CAMPAIGN_WARMUP_DAYS` | `14` | Min warmup days before an inbox may stay on ACTIVE campaigns |
| `ENABLE_CAMPAIGN_TOP_UP` | `true` | Rebalance warmed generics to keep ACTIVE campaigns at their floor |
| `MIN_CAMPAIGN_SENDERS` | `50` | Sender floor for ACTIVE campaigns |
| `ENFORCE_MAILBOX_SETTINGS` | `true` | Converge every mailbox to warmup on + daily send cap |
| `MESSAGE_PER_DAY` | `30` | Smartlead `max_email_per_day` fleet cap |
| `CAMPAIGN_STATUSES` | `ACTIVE,PAUSED` | Which campaigns are eligible |
| `PROVIDER_IDS` | _(auto)_ | Comma-separated seed provider ints; empty = auto-fetch |
| `STATE_FILE_PATH` | `/data/state.json` | Persist tested campaigns + alert dedupe |
| `RUN_TOKEN` | _(empty)_ | Required to enable `/status`, `/run` and `/approvals/*` |
| `DRY_RUN` | `false` | Plan remediation without applying writes; also skips pool mailbox purchases |
| `REQUIRE_SPEND_APPROVAL` | `true` | Hold pool mailbox purchases for human approval via `/approvals` instead of spending automatically |

**Do not hardcode secrets.** Set them as Railway service variables.

## Local development

Two-person workflow: read [CONTRIBUTING.md](CONTRIBUTING.md) before starting.
Every task branches from current `main`, is claimed in Slack, and merges through
a reviewed PR. Production deployment ownership is documented in
[DEPLOYMENT.md](DEPLOYMENT.md).

```bash
cp .env.example .env
# fill in SMARTLEAD_API_KEY + SLACK_WEBHOOK_URL
npm install
npm run dev
```

Useful commands:

```bash
npm run typecheck
npm test
curl -X POST http://localhost:3000/run
```

## Railway deploy

This service is meant to sit alongside your other internal tools (AI reply handler, auto-CRM sync, client onboarding).

1. Create/add a service in your existing Railway project (recommended) or deploy this repo.
2. Attach a **volume** mounted at `/data` so `STATE_FILE_PATH=/data/state.json` survives restarts.
3. Set the environment variables above as Railway secrets.
4. Deploy. Health check: `GET /health`.

```bash
railway up --detach -m "Deploy Deliverability Wizard"
```

After deploy, optionally force a first run:

```bash
curl -X POST "https://<your-service>/run" -H "X-Run-Token: $RUN_TOKEN"
```

## Quota behavior

```
used = number of existing SmartDelivery tests
needed = sum over eligible campaigns of ceil(mailboxCount / 50)

if used + needed > TOTAL_TEST_QUOTA:
  create nothing
  Slack notify with per-campaign test counts
else:
  create all planned tests
```

## Tracking

The app keeps a local state file of campaigns it has already tested and also cross-checks SmartDelivery's existing test list (`campaign_id`) so the same campaign is not tested repeatedly across restarts.
