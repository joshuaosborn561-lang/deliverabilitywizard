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
- Healthcheck: `/health` (api; staff/isolation can use the same — they
  do not listen unless `ROLE=api` or `ROLE=all`)
- Restart policy: ALWAYS

| Service | `ROLE` | Needs `/health` listener? |
|---|---|---|
| `wizard-v2-api` | `api` | yes (port `$PORT`) |
| `wizard-v2-staff` | `staff` | no — set healthcheck off or run `ROLE=all` only for a cheap single-box trial |
| `wizard-v2-isolation` | `isolation` | no |

Staff and isolation do not bind HTTP. Either:

- disable their Railway healthcheck, or
- run a **trial** as one service with `ROLE=all` (api + both crons in
  one process — fine for shadow week, not the production split).

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
