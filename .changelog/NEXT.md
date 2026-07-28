# Unreleased Changes

## Quota burn

- **[issue-3179] Quota-burn no longer spends window budget on runs that never happened** — a scheduled quota-burn run counted against the family's per-window dispatch cap as soon as it was considered, even when it was subsequently skipped and no agent was ever started. Those phantom dispatches ate the budget, so a family configured for e.g. 5 burns per reset window could fire far fewer — and a family capped at 1 could never fire at all, because the skipped run consumed the only slot before the next gate re-read it. A burn is now counted once its agent has actually run, and a burn that is queued or in progress holds its slot in the meantime, so the cap stays accurate without letting a second app or a repeated "Run" overshoot it.

## Fixed

- **Branch reconciler no longer hands long-lived shared branches to the coordinator agent.** `gh-pages` (the GitHub Pages publishing branch) is now protected alongside `main`/`master`/`dev`/`develop`/`release`, so the scheduled `branch-reconcile` task never tries to "open a PR" merging it into the default branch (which would break the published site). The reconciler now reuses the single canonical `PROTECTED_BRANCHES` set in `server/lib/gitArgs.js` instead of its own narrower list, so it also picks up `dev`/`develop` protection.

## Changed

- **Chief of Staff feedback now captures why an agent helped or missed the mark.** Add detail to positive, negative, or neutral ratings so future CoS learning has the context needed to improve.

- **Branch reconciler prioritizes recognized work branches.** The in-flight set handed to the coordinator agent is now ordered by branch prefix — `claim/`, `cos/`, `next/`, `feature/`, `fix/`, and other conventional prefixes are reconciled ahead of unrecognized/ad-hoc branches — so a bounded run spends its budget on real deliverables first. Both `/` and `-` separators match.
