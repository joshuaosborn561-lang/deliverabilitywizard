# Contributing

This repository is maintained by Josh (`@joshuaosborn561-lang`) and Cayden
(`@cayden-design`). `main` is the shared source of truth. Neither person
commits directly to `main`.

## Start every task from current `main`

```bash
git switch main
git pull --ff-only origin main
git switch -c josh/short-task-name
# or
git switch -c cayden/short-task-name
```

Cursor Cloud Agents use their generated `cursor/...` branch. Do not rename an
active agent branch or push onto another person's branch.

One branch should contain one task. If the requested work grows into an
unrelated change, start another branch and PR.

## Claim the work before editing

Send a short Slack message before starting:

> Working on campaign top-up safety in `src/services/campaignTopUp.ts`.

Then open a draft PR early. The Slack message handles immediate coordination;
the draft PR is the durable ownership record. This is especially important for
shared hotspots:

- `src/config.ts`
- `src/index.ts`
- `src/state/store.ts`
- `src/clients/*`
- `.github/workflows/*`
- `DECISIONS.md` / `CLAUDE.md`

If someone already owns the same area, agree on file boundaries or let one
person finish first. Do not both edit a shared file silently.

## Commit and push in small pieces

```bash
git add <files-for-one-logical-change>
git commit -m "Describe the behavior changed"
git push -u origin HEAD
```

Commit each logical change separately. Push often so work is backed up and the
other maintainer can see it. Never commit `.env` files, API keys, downloaded
production state, or generated runtime logs.

## Keep the branch current

Before requesting review:

```bash
git fetch origin
git merge origin/main
npm ci
npm run typecheck
npm test
```

Use `git merge origin/main` on a branch another person may have pulled. Rebase
only your own private branch, and never force-push unless the reviewer agreed.

When Git reports a conflict, the person merging second resolves it. For
non-trivial behavior conflicts, stop and talk through which behavior should
win—do not select “ours” or “theirs” blindly.

## Pull requests

Every change reaches `main` through a PR, including documentation and
maintainer-authored changes.

- Keep the PR focused and describe user-visible behavior.
- Complete the test plan in the template.
- Request the other maintainer as reviewer.
- Resolve review conversations.
- Wait for required CI checks.
- Prefer squash merge for a noisy branch; preserve separate commits when they
  tell a useful operational story.
- Delete the branch after merge.

Product decisions recorded in `DECISIONS.md` require Josh to approve a
reversal. Normal bug fixes, tests and refactors can be reviewed by either
maintainer. The current rules live in [CANON.md](CANON.md) — a PR that
lands a new decision appends the ledger entry, adds its guard, deletes the
code it retires, and updates CANON.md **in that same PR** (the meta-guards
fail the suite otherwise).

## Production and spending

- Production should deploy **only `main`**.
- A feature-branch push must never be a production deployment.
- Real-money actions stay behind the spend approval gateway.
- Do not weaken `RUN_TOKEN`, warmup, client-branding, campaign-floor or spend
  rules merely to make a test pass.

See [DEPLOYMENT.md](DEPLOYMENT.md) for deployment ownership and
[GitHub branch protection](docs/BRANCH_PROTECTION.md) for repository settings.
