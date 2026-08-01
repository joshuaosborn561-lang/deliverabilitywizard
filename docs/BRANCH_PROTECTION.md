# GitHub branch protection

Create a GitHub branch ruleset for `main`:

1. Open **Settings → Rules → Rulesets → New branch ruleset**.
2. Target the branch name `main`.
3. Enable **Require a pull request before merging**.
4. Require at least **1 approval**.
5. Enable:
   - Dismiss stale approvals when new commits are pushed
   - Require review from Code Owners
   - Require conversation resolution before merging
   - Block force pushes
   - Block branch deletion
6. Require the CI status check named **`check`** after the CI workflow has
   landed on `main`.
7. Allow only repository admins to bypass, for genuine production emergencies.

Recommended merge methods:

- Enable squash merge and regular merge.
- Disable rebase merge if either maintainer is uncomfortable resolving
  rewritten history.
- Automatically delete head branches after merge.

Repository rulesets are GitHub settings, not files in this repository. This
document records the intended configuration so it can be audited and restored.
