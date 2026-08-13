# Self-Update Flow

How PortOS notices a new release and updates itself. PortOS is distributed software — many people run it, and a large share run it from a **personal fork**, so every step here is fork-aware. Breaking that assumption produces silent no-op updates.

Code: `server/services/updateChecker.js`, `server/routes/update.js`, `server/lib/gitRemote.js`, `update.sh` / `update.ps1`, `client/src/components/apps/tabs/UpdateTab.jsx`.

## Release polling always targets upstream

The release-notification poll **always queries the upstream `atomantic/PortOS`** repo, so a user running from a fork still sees new upstream versions. The constants come from `server/lib/gitRemote.js` (`UPSTREAM_OWNER`, `UPSTREAM_REPO`, `UPSTREAM_FULL_NAME`) — do not re-hardcode the upstream slug anywhere else.

## Classifying the local remote

`getOriginInfo()` in `server/lib/gitRemote.js` classifies the local `origin` remote into `{ isUpstream, isFork, isGithub, owner, repo, fullName }`. `getUpdateStatus()` returns this as `remoteInfo`, alongside a fixed `upstream` block.

**New UI that says "you are running PortOS" must read `remoteInfo.isUpstream`, not just `currentVersion`** — otherwise it lies to fork users.

## Pulling: origin, not upstream

`update.sh` / `update.ps1` always `git pull --rebase --autostash` from **origin**. A fork user who has not merged upstream into their fork gets a silent no-op pull.

### The update always lands on `main` first

Before pulling, both scripts check the current branch and **switch to `main` if you are anywhere else** — a feature branch or a detached HEAD. This is deliberate: the rest of the script (install, build, restart) has to run on the revision the app will boot from, and pulling on a feature branch would leave the running app on a version the update never advanced.

If the working tree is dirty at that point (unstaged, staged, or untracked files), the scripts **`git stash push -u`** first so the checkout can proceed, tagging the entry `portos-update-<timestamp>`. The stash is intentionally **not** popped afterwards — the remaining steps need `main`'s contents on disk. On completion the scripts print how to get back:

```bash
git checkout <your-branch>   # or the recorded SHA, if you were on a detached HEAD
git stash pop
```

The entry is at the top of `git stash list`. Nothing is stashed when the tree is clean, and nothing is checked out when you were already on `main`.

**So: an in-app or CLI update run from a feature branch will leave your checkout on `main` with your work parked in the stash.** Commit or push before updating if you would rather not deal with that.

To prevent that confusion, `POST /api/update/execute` rejects fork runs with **412 `FORK_SYNC_REQUIRED`** unless either:

- the request body sets `acknowledgeFork: true`, or
- `lastForkSync.fullName` matches `remoteInfo.fullName` (compared case-insensitively — GitHub owner/repo names are) and is less than 10 minutes old. The service computes this once as `status.forkSyncFresh` from `FORK_SYNC_FRESHNESS_MS`; the route and the UI both read that flag rather than re-implementing the time math.

## Syncing a fork

`POST /api/update/sync-fork` shells out to:

```bash
gh repo sync <owner>/<fork> --source atomantic/PortOS --branch <branch>
```

`gh` is fast-forward only by default, so a diverged fork `main` returns **409 `FORK_DIVERGED`**. **Never add `--force` server-side** — the error message instead points the user at the explicit `--force` command they can run from their own terminal if they really want to discard fork commits.

## Fork UI: three distinct buttons

When `isFork` is true, `UpdateTab` replaces the single "Update Now" button with three:

| Button | Behavior |
|--------|----------|
| Sync Fork & Update | `sync-fork`, then `execute` |
| Sync Fork Only | `sync-fork`, no update |
| Update from Fork As-Is | `execute` with `acknowledgeFork: true` |

Keep these three behaviors distinct. Collapsing them strips the user's agency over what touches their GitHub fork.
