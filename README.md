# Deliverability Wizard

Internal service that keeps SalesGlider's Smartlead cold-email fleet
healthy: staffs campaigns, enforces warmup and rest, runs SmartDelivery
placement instrumentation, pauses on bounce trouble, and speaks in Slack
only when a human decision is needed. Railway watches `main`
(`deliverabilitywizard` / production) and auto-deploys every merge.

Two people drive this repo: **Josh** owns product calls; **Cayden**
contributes alongside him. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Where the rules live

- **[CANON.md](CANON.md)** — one page of current truth. Read it before
  changing behaviour; it is updated in the same PR as any new decision.
- **[DECISIONS.md](DECISIONS.md)** — the append-only ledger of every call
  Josh has made, most of it superseded. Use it for *why* a rule exists,
  never for *what* the rules are.
- **`src/guards/`** — tests that fail the suite when code reverses a
  decision. A guard names the decision and who to ask. Do not delete a
  guard to go green.

This README stays operational on purpose: what runs, how to run it, where
to look. Behaviour questions end at CANON.md.

## The machine at a glance

| Loop | Cadence | Owns |
|------|---------|------|
| Canon sweep (health) | every 15 min | One shared Smartlead inventory fetch, reconnect, client A/B rest + generic send clock, 21-day warmup gate, fan-out / top-up, mailbox settings converge, signature fixes, placement-test backfill |
| Bounce loop | every 10 min | Pause over 10% lifetime bounce after 1k leads, or >10 new bounces in 10 min; classify the NDRs (tenant cap / bad recipients / content block); keep Smartlead's native auto-pause off |
| Campaign check | hourly | Re-inspect blocked first-checks, shells, signatures, staffing floor, campaign min-gap converge |
| Monitor | every 6 h | POD tags first (so decoration writes are not starved by placement pulls), then placement pulls, DNS advisory audit, canary adoption, campaign audit, domain→client advisory |
| Client-day brief | 10:00, 13:00, 16:30 New York | Same Slack scoreboard each slot: per-client sends + spam, untagged campaigns, loaded DRAFTs, domains needing a human |
| Boot | on deploy | Canary attach at 90 s only — everything else waits for its cron |

Standing posture, in one breath (decision numbers and detail in CANON.md):
pulls are **kill-only** — placement scores, bounce rates, blacklists and
leftover HOLD-UNTIL tags never yank a mailbox; one client per sender,
staffing floor is half that client's own inboxes; every mailbox owes 21
warmup days from InboxKit import unless its fleet is pre-warmed; the
canary fleet diagnoses and never staffs; Slack carries exactly three pages
(burned domain, isolated spam word, client-day scoreboard at 10:00/13:00/16:30 ET) plus action receipts;
real-money spend stops at `/approvals`.

## Surfaces

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Public liveness: `canonCompliant`, open `canonFindings` by kind, per-stage `stageHealth` |
| `GET` | `/status` | Full state + effective config (requires `X-Run-Token`) |
| `POST` | `/run` | Manual trigger: `?mode=scan\|monitor\|pool\|reconnect\|warmup-gate\|health\|all` |
| `GET` | `/approvals` | Token-authenticated read-only approval listing |
| `GET` | `/ops` | Employee console (owner/operator roles, audit log) |

`/status`, `/run`, and `/approvals/*` stay disabled when `RUN_TOKEN` is
unset. `/health` is the only unauthenticated operational endpoint.

**Production truth comes from Railway logs and `/health`** — the
`[canon]`, `[watchdog]`, `[campaign-check]`, `[bounce-autostop]`, and
`[health]` log lines exist so nobody has to guess state.

## Environment variables

Copy `.env.example` and fill in the required keys: `SMARTLEAD_API_KEY`
plus Slack (`SLACK_WEBHOOK_URL`, or bot token + channel). The full set
lives in `src/config.ts`; the load-bearing ones:

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_CAMPAIGN_WARMUP_DAYS` / `FRESH_INBOX_WARMUP_DAYS` | `21` | Warmup owed from InboxKit import before live send |
| `EXTRA_GENERIC_DOMAINS` | 6 fleet domains | Generic-pool membership (staffing supply) — does NOT skip warmup |
| `PREWARMED_DOMAINS` | crosslaunchco.com, crossscaleco.com, cleartechco.com | The only warmup exemption; granted by Josh alone |
| `MESSAGE_PER_DAY` | `30` | Campaign sends per mailbox per day (warmups excluded) |
| `MAILBOX_MIN_TIME_GAP_MINS` | `10` | Minimum send gap, converged at mailbox AND campaign level |
| `CAMPAIGN_ESP_MIX_MIN_PERCENT` | `30` | Minimum Google / Microsoft share when topping up |
| `ENABLE_CLIENT_REST` / `ENABLE_GENERIC_SEND_REST` | `true` | Client A/B fortnight; generic 14-day send clock |
| `TOTAL_TEST_QUOTA` | `0` | SmartDelivery test cap; 0 = unlimited |
| `MAX_MAILBOXES_PER_TEST` | `50` | SmartDelivery API limit per test |
| `TOP_UP_EXCLUDE_CAMPAIGNS` | MSRS / HVAC / Roofers ids | Campaigns the staffing loop leaves alone |
| `REQUIRE_SPEND_APPROVAL` | `true` | Hold real-money spend for `/approvals`; single-use approvals, $25 domain / 25 mailbox monthly caps |
| `RUN_TOKEN` | _(empty)_ | Required to enable `/status`, `/run`, `/approvals/*` |
| `OPS_UI_ENABLED` + owner/operator usernames, tokens, `OPS_SESSION_SECRET` | — | Employee console; never reuse `RUN_TOKEN` for login |
| `DRY_RUN` | `false` | Plan writes without applying; skips pool buys entirely |

**Do not hardcode secrets.** Set them as Railway service variables.
Variable *values* are not readable over the OAuth connection (names are) —
deploy code that logs what you need instead of guessing at config.

## Local development

```bash
cp .env.example .env
# fill in SMARTLEAD_API_KEY + Slack
npm install
npm run typecheck && npm test
npm run dev
```

`npm run typecheck && npm test` must pass before any behaviour change —
the guard suite in `src/guards/` is part of the test run.

## Railway deploy

1. Attach a volume at `/data` (`STATE_FILE_PATH=/data/state.json`).
2. Set the variables above as Railway secrets.
3. Merge to `main`. Health check: `GET /health`.

Every deploy restarts the app and **resets the cron cycle**, so space out
merges when a scheduled job needs to actually run. The only Smartlead work
at boot is canary attach at 90 s — health, pool, and campaign-audit wait
for their crons (boot-kicking them raced attach and 429'd the board).

`railway.toml` pins **one replica**. Do not scale without a shared lock.
