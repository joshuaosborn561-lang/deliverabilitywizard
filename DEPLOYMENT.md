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

## One-time transition from the current branch setup

As of August 1, 2026, Railway watches
`cursor/generic-pool-expand-240-2606`, while `main` is behind the deployed
application. Restore the normal workflow in this order:

1. Merge the generic-pool PR into `main`.
2. Retarget the stacked safety-fixes PR to `main`, review its now-small diff,
   and merge it.
3. Bring the collaboration/governance PR up to date with `main` and merge it.
4. Change Railway's source branch from
   `cursor/generic-pool-expand-240-2606` to `main`.
5. Confirm the first `main` deployment is healthy.
6. Close/delete obsolete long-lived branches only after production is verified.

Until step 4, merging to `main` does not deploy production. After step 4,
feature branches must never be connected to Railway.

Changing Railway's source branch is an owner/admin action in Railway and is not
performed by repository code.
