# Deploy v2 as a parallel Railway service

**Do not create Railway resources from this chat.** **Do not point the
production wizard at this directory.** `main` stays the old app.

v2 is this folder (`v2/`), meant to run as **three** Railway services
plus **one Postgres**. All three share `DATABASE_URL`. `WRITE_ENABLED`
stays unset. `SHADOW` stays true (the default).

## 1. Postgres

1. In a new Railway project (or the existing project, **new** plugin),
   add **Postgres**.
2. Copy `DATABASE_URL`.
3. From a laptop with that URL: `cd v2 && npm ci && DATABASE_URL=… npm run migrate`

`src/index.ts` also runs `store.migrate()` on boot, so a first deploy
creates tables if the URL is set.

## 2. Three services, same repo, root directory `v2`

Create **three** Railway services from this GitHub repo. For each:

- Root directory / watch path: **`v2`**
- Builder: Nixpacks (`v2/railway.toml`)
- Start: `npm run start`
- Healthcheck: `/health` on **every** service (all roles bind `$PORT`)
- Restart policy: ALWAYS

| Service | `ROLE` | Needs `/health` listener? |
|---|---|---|
| `wizard-v2-api` | `api` | yes (port `$PORT`) |
| `wizard-v2-staff` | `staff` | yes — `/health` 200 even while migrate is starting |
| `wizard-v2-isolation` | `isolation` | yes |

Staff and isolation bind **`/health` only** (not `/compare` / `/intended`)
so a Railway healthcheck cannot restart them before the first tick. Boot
runs one tick immediately with a hard timeout (staff 10m, isolation 8m)
and AbortController on every fetch; cron `*/15` plus a 15-minute
`setInterval` backup. Every skip logs `reason=` including `timeout`
with `hung_in=`. Stale in-flight leases clear at boot.

## 3. Shared variables (all three)

```
DATABASE_URL=<postgres>
SHADOW=true
WRITE_ENABLED=false
REQUIRE_SPEND_APPROVAL=true
SMARTLEAD_API_KEY=<same as production, reads only>
SMARTDELIVERY_API_KEY=<same as production, reads only>
INBOXKIT_API_KEY=<same as production, reads only>
OLD_WIZARD_HEALTH_URL=https://deliverabilitywizard-production.up.railway.app/health
CANARY_FLEET_EMAILS=<living fleet, comma emails>
```

Do **not** set `SLACK_BOT_TOKEN` unless you want intended Slack to
execute after cutover. Shadow never posts.

Do **not** set `WRITE_ENABLED=true`.

## 4. Prove shadow

1. Open `https://<api>.up.railway.app/health`
   - `shadow: true`, `writeEnabled: false`, `writesAllowed: false`
2. Wait one staff + one isolation tick (~15m)
3. `GET /intended` — attach/detach/isolate/test rows with
   `executed: false`, `shadowed: true`
4. `GET /compare` — diffs v2 intended + findings against the old
   wizard `/health`
5. Confirm production `#deliverability` did **not** get v2 posts, and
   Smartlead tests were not created.

## 5. Hosting cost (audit)

About **+$25–50/mo** for two extra replicas + Postgres vs today.
A `ROLE=all` trial is cheaper (~+$5–15 Postgres only if you already
have a box).

## 6. Do not merge to main

This branch is long-lived. Production auto-deploys `main`. A merge
would not swap the old start command unless someone changes the
production service root — still **do not merge** until Josh says so.
