# Deliverability Wizard v2 (parallel, shadow-by-default)

Long-lived parallel system. The old wizard on `main` is untouched and
stays in production.

- **api** — `/health`, `/compare`, `/intended`, `/findings`
- **staff** — jobs 1, 2, 3, 5, 6 (40/POD, exclusivity + ESP mix,
  warmup peel, copy/sig/merge-tag QA, lapsed delete)
- **isolation** — job 4 (fleet-only canaries, 30m deadline, `Auto:`
  warmed match, one canary test per campaign)
- **Postgres** — inventory, findings, intended actions, isolation
- **SHADOW** on, **WRITE_ENABLED** off — reads Smartlead, logs every
  intended attach/detach/isolate/test/slack/spend, **zero writes**

See `DEPLOY.md` (Railway + Postgres) and `CUTOVER.md` (the one flag).
See `OMITTED.md` for every old feature left out, with its decision
number, for Josh to review.

```
cd v2
npm ci
npm run typecheck
npm test
```
