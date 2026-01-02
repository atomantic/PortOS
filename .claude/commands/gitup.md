# Git Push with Rebase

Push local commits to the dev branch, automatically rebasing over any CI version bump commits.

## Command

```bash
git pull --rebase --autostash && git push
```

## Why This is Needed

The dev branch receives automatic `[skip ci]` commits that bump the package.json version after each successful CI run. When pushing local changes, you'll often need to rebase over these version bump commits.

## What It Does

1. **`--autostash`** - Stashes any uncommitted changes before pulling, then re-applies them after
2. **`--rebase`** - Replays your local commits on top of the remote changes (cleaner than merge commits)
3. **`git push`** - Pushes your rebased commits to remote

## When to Use

Use `/gitup` instead of `git push` when working on the dev branch. This handles the common case where CI has pushed a version bump while you were working locally.
