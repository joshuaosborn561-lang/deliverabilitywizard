# GitHub branch protection

Create a GitHub branch ruleset (or classic branch protection) for `main`:

1. Open **Settings → Rules → Rulesets → New branch ruleset** (or
   **Settings → Branches → Branch protection rule** for classic protection).
2. Target the branch name `main`.
3. Enable **Require a pull request before merging**.
4. Require at least **1 approval**.
5. Enable:
   - Dismiss stale approvals when new commits are pushed
   - Require conversation resolution before merging
   - Block force pushes
   - Block branch deletion
6. Do **not** require review from Code Owners as a merge gate. Josh stays
   CODEOWNER of the canon definition files (`CANON.md`,
   `docs/LOCKED-CANON.md`, and `src/lib/lockedCanon.ts`) so GitHub still
   requests him when those files change. A canon-consistent PR edits
   `CANON.md` outside the LOCKED section and must be mergeable without
   Josh's review. Paths that only implement a locked rule are not
   Josh-only in CODEOWNERS (D322).
7. Require these CI status checks. Do not remove either one:
   - **`check`**
   - **`locked-canon`**
8. Allow only repository admins to bypass, for genuine production emergencies.
9. **LOCKED canon merge gate (D285, amended by D322).**
   - Canon-consistent PRs — the LOCKED section of `CANON.md`,
     `docs/LOCKED-CANON.md`, and `src/lib/lockedCanon.ts` unchanged —
     pass `locked-canon` without Josh's approval. The Deliverability bot
     may merge them when the required checks are green.
   - PRs that modify those locked canon files or rules fail `locked-canon`
     unless the PR has the `canon-change` label approved by Josh
     (`joshuaosborn561-lang` applied that label, or he approved the pull
     request while the label is present). Canon edits themselves still
     need Josh.
   - Without that label and Josh's approval the job fails, and those PRs
     must **never auto-merge**.

Recommended merge methods:

- Enable squash merge and regular merge.
- Disable rebase merge if either maintainer is uncomfortable resolving
  rewritten history.
- Automatically delete head branches after merge.

Repository rulesets are GitHub settings, not files in this repository. This
document records the intended configuration so it can be audited and restored.
