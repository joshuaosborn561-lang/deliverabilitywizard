# Deployment workflow

## Steady state

Railway should watch `main`. A production deployment happens only after:

1. A feature branch PR is approved.
2. Required CI checks pass.
3. The PR is merged into `main`.

Do not run `railway up` from a feature branch and do not configure Railway to
watch a personal or agent branch. That bypasses review and makes the deployed
code differ from the repository's source of truth.

After a merge, verify:

- Railway deployment succeeded for the `main` commit.
- Service replica count is **1** (operations locks are process-local).
- `GET /health` returns `ok: true`.
- Boot logs show the expected feature flags and cron schedules.
- Any required database/state migration completed.

Rollback by redeploying a known-good commit from `main`, then open a PR that
reverts or fixes the bad change. Do not create an unreviewed long-lived
production branch.
