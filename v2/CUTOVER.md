# WRITE_ENABLED cutover and rollback

v2 has **one** cutover flag. Shadow is the default.

| Env | Default | Meaning |
|---|---|---|
| `SHADOW` | `true` | Hard read-only. Wins over `WRITE_ENABLED`. |
| `WRITE_ENABLED` | `false` | The later cutover switch. |

Writes (Smartlead attach/detach, InboxKit delete, Slack post, spend)
run **only** when:

```
WRITE_ENABLED=true
SHADOW=false
```

Anything else logs the intended action to Postgres and returns.

## Flip (when Josh says the shadow week is good)

Do this on the **v2** Railway services only. Leave the old wizard
running until v2 is trusted.

1. Confirm `GET /health` on v2: `canonCompliant` understood,
   `uglyWithoutIsolation` empty or queued, `/compare` notes read.
2. Confirm `GET /intended` looks like the actions you want.
3. Set on **all three** v2 services:
   ```
   SHADOW=false
   WRITE_ENABLED=true
   ```
   Keep `REQUIRE_SPEND_APPROVAL=true`.
4. Redeploy. First ticks execute previously-shadowed kinds.
5. Watch Smartlead (no duplicate canary tests), `#deliverability`,
   and v2 `/health`.
6. Only then pause or shrink the **old** wizard service.

Do **not** merge this branch to `main` as part of the flip. Changing
the production service's root directory / start command is a Railway
click, not a git merge.

## Rollback (minutes)

On all three v2 services:

```
WRITE_ENABLED=false
SHADOW=true
```

Redeploy. Writes stop immediately. Intended actions keep logging.
The old wizard, if still up, is already the source of truth.

If the old wizard was already paused, start it again on `main`
(unchanged code) before or as you flip v2 back to shadow.

## What v2 will never do even after the flip

- Spend without a stored approval (`REQUIRE_SPEND_APPROVAL`)
- Pause a campaign from the bounce loop (D148)
- START a CALLER FOLLOW-UP campaign (D242) — that stays the
  allo-caller router
- Score released canary emails (`aminarodriguez@getcrosslaunchco.info`
  and the 2026-10-05 list)
- Create a second `Canary copy: #<id>` while one is living
- Skip a 0% fleet score because it is "fresh"
- Treat a failed `listTests` as an empty board
