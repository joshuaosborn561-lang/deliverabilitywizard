# Deliverability Wizard

Internal automation service that finds new Smartlead campaigns and automatically creates SmartDelivery placement tests — no manual setup each time.

## What it does

1. **Twice a week** (Mon & Thu 09:00 UTC by default) scans Smartlead for campaigns that do not already have a placement test.
2. For each eligible campaign, pulls **sender mailboxes** and **email sequence/copy**.
3. Creates SmartDelivery **manual placement tests** with:
   - `spam_filters: ["spam_assassin"]` explicitly set
   - `link_checker: true` explicitly set
   - mailboxes split into batches of **≤ 50** senders per test
4. Before creating anything, checks **total test usage vs a 120-test quota**. If the full batch would exceed the quota, **nothing is created** and Slack is notified so you can prioritize or wait.
5. On a separate schedule (every 6 hours by default), monitors results and Slack-alerts when:
   - a **domain/IP is blacklisted**, or
   - **inbox deliverability falls below 90%** (provider or sender-mailbox level)

Manual trigger is available via `POST /run`.

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
| `GET` | `/status` | Full state + effective config |
| `POST` | `/run` | Manual scan (`?mode=scan\|monitor\|both`) |

If `RUN_TOKEN` is set, pass header `X-Run-Token: <token>`.

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
| `DELIVERABILITY_THRESHOLD` | `90` | Slack when inbox placement is below this % |
| `CRON_SCAN` | `0 9 * * 1,4` | Twice weekly scan |
| `CRON_MONITOR` | `0 */6 * * *` | Results / blacklist polling |
| `CAMPAIGN_STATUSES` | `ACTIVE,PAUSED` | Which campaigns are eligible |
| `PROVIDER_IDS` | _(auto)_ | Comma-separated seed provider ints; empty = auto-fetch |
| `STATE_FILE_PATH` | `/data/state.json` | Persist tested campaigns + alert dedupe |
| `RUN_TOKEN` | _(empty)_ | Protects `/run` when set |

**Do not hardcode secrets.** Set them as Railway service variables.

## Local development

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
