# Self-Update Flow

How PortOS notices a new release and updates itself. PortOS is distributed software — many people run it, and a large share run it from a **personal fork**, so every step here is fork-aware. Breaking that assumption produces silent no-op updates.

Code: `server/services/updateChecker.js`, `server/services/updateExecutor.js`, `server/services/appUpdater.js`, `server/routes/update.js`, `server/lib/gitRemote.js`, `server/lib/detachedSpawn.js`, `update.sh` / `update.ps1`, `scripts/verify-server-health.js`, `client/src/components/apps/tabs/UpdateTab.jsx`.

## Release polling always targets upstream

The release-notification poll **always queries the upstream `atomantic/PortOS`** repo, so a user running from a fork still sees new upstream versions. The constants come from `server/lib/gitRemote.js` (`UPSTREAM_OWNER`, `UPSTREAM_REPO`, `UPSTREAM_FULL_NAME`) — do not re-hardcode the upstream slug anywhere else.

## Classifying the local remote

`getOriginInfo()` in `server/lib/gitRemote.js` classifies the local `origin` remote into `{ isUpstream, isFork, isGithub, owner, repo, fullName }`. `getUpdateStatus()` returns this as `remoteInfo`, alongside a fixed `upstream` block.

**New UI that says "you are running PortOS" must read `remoteInfo.isUpstream`, not just `currentVersion`** — otherwise it lies to fork users.

## Pulling: origin, not upstream

`update.sh` / `update.ps1` always `git pull --rebase --autostash` from **origin**. A fork user who has not merged upstream into their fork gets a silent no-op pull.

### The update always lands on `main` first

Before pulling, both scripts check the current branch and **switch to `main` if you are anywhere else** — a feature branch or a detached HEAD. This is deliberate: the rest of the script (install, build, restart) has to run on the revision the app will boot from, and pulling on a feature branch would leave the running app on a version the update never advanced.

If the working tree is dirty when switching off a non-`main` branch or detached HEAD (unstaged, staged, or untracked files), the scripts perform explicit pre-checkout stashing via **`git stash push -u`** so the checkout can proceed, tagging the entry `portos-update-<timestamp>`. The stash is intentionally **not** popped afterwards — the remaining steps need `main`'s contents on disk. On completion the scripts print how to get back:

```bash
git checkout <your-branch>   # or the recorded SHA, if you were on a detached HEAD
git stash pop
```

The entry is at the top of `git stash list`. When already on `main`, pre-checkout stashing is skipped and dirty working trees rely instead on `git pull --autostash` during the pull. Nothing is stashed when the tree is clean, and no checkout occurs when already on `main`. Note that `git stash pop` restores file contents but not the index — anything you had staged comes back unstaged, so re-`git add` it (or pop with `--index`).

**So: an in-app or CLI update run from a feature branch will leave your checkout on `main` with your work parked in the stash.** Commit your work before updating if you would rather not deal with that — pushing alone does not help, since the stash covers uncommitted changes.

### Submodules follow the pulled parent revision

After pulling `main`, both platform scripts run:

```bash
git submodule sync --recursive
git submodule update --init --recursive
```

The sync step refreshes each checkout's local submodule metadata from the newly pulled `.gitmodules`; the update step initializes missing modules and restores every recursive checkout to the commit pinned by PortOS. It intentionally does **not** use `--remote`: a release consumes the reviewed gitlink commit, not an unreviewed newer submodule head.

All restart-triggering UI actions (`Update Now`, `Sync Fork & Update`, both “from Fork As-Is” variants, and the reconcile variants) launch `update.sh` or `update.ps1`, so they inherit this exact sequence. `Sync Fork Only` remains intentionally different: it only fast-forwards the GitHub fork and does not touch the local checkout.

After source update and restart, the normal boot migration pass upgrades
versioned PortOS-owned data before route initialization. Eidoverse World Design
updates use this path: the offline migration changes only
`data/eidoverse/portos-world.json`, preserving V1 custom leaves as explicit V2
overrides and recording a pending checkpoint. A post-boot, non-AI reconciler
applies that checkpoint only when the separately managed Eidoverse runtime is
already online; otherwise the Eidoverse page keeps the update pending with a
direct managed-app remediation link. Update scripts never mutate the external
Eidoverse checkouts to apply a PortOS world design.

`GET /api/update/status` also compares recursive submodule checkouts with their pinned revisions. An uninitialized, conflicted, behind, or divergent module marks the install out of sync, making the existing Reconcile control available even when no newer release is waiting. A checkout deliberately advanced through the Submodules tab is not treated as stale, and CoS worktrees report submodule state as unknown because they intentionally leave submodules uninitialized and cannot run the primary-checkout update flow.

For the point-in-time analysis of macOS Finder metadata false positives and the separate managed-App build omission, see [macOS “Install out of sync” research](research/2026-09-03-macos-install-out-of-sync.md).

To prevent that confusion, `POST /api/update/execute` rejects fork runs with **412 `FORK_SYNC_REQUIRED`** unless either:

- the request body sets `acknowledgeFork: true`, or
- `lastForkSync.fullName` matches `remoteInfo.fullName` (compared case-insensitively — GitHub owner/repo names are) and is less than 10 minutes old. The service computes this once as `status.forkSyncFresh` from `FORK_SYNC_FRESHNESS_MS`; the route and the UI both read that flag rather than re-implementing the time math.

## Every PortOS update goes through the detached launcher

`update.sh` deletes and restarts every PortOS PM2 entry. PM2's TreeKill walks **PPID**, so a script left attached to `portos-server` is killed by its own `pm2 delete` step — mid-list, before it can run the closing `pm2 start` — and the install is left headless. `spawnDetached`'s double-fork (`server/lib/detachedSpawn.js`) is what reparents the script to init so it survives; `executeUpdate()` in `server/services/updateExecutor.js` is the single launcher that applies it, along with the `STEP:` progress parsing, the still-running-script guard, and `recordUpdateResult()`.

**PortOS is also a managed app**, so an update started from **App Management** reaches `update.sh` through `appUpdater.js` rather than `routes/update.js`. That path delegates to `executeUpdate()` for the PortOS record instead of spawning the script itself — a second detached-spawn implementation would be one more thing to keep in sync, and the attached one it replaced produced exactly the headless failure above (#5976). `appUpdater` also **skips its own `restart` step** for that case: the script runs `pm2 start ecosystem.config.cjs` itself, so restarting on top of it would be redundant and would race the script.

Both entry points take the same atomic `setUpdateInProgress(true)` lock before launching, so they cannot run `update.sh` concurrently — and because that flag is what `subAgentSpawner`, `agentLifecycle` and `persistentMindSupervisor` gate on, holding it also stops a CoS agent from being spawned into a process the script is about to `pm2 delete` (#4124).

A PortOS record carrying a custom `updateCommand`, or a `repoPath` that is not this checkout, keeps the ordinary attached path — delegating there would silently run `update.sh` instead of the configured command. That decision is logged rather than silent, since the attached path is the one that failed. The `repoPath` comparison resolves symlinks and case-folds on macOS/Windows: `repoPath` is user-editable and not force-synced, so a trailing slash or a different spelling must not be mistaken for a different checkout. Non-PortOS managed apps are unaffected and still get their own PM2 restart from `appUpdater`. The dashboard handoff it starts before that restart is PortOS-only — it opens the PortOS dashboard, so it would be meaningless after another app's update.

## Post-update health verification

`pm2 start` exiting 0 is not proof the server came back, and the process that would notice is the one that did not. Both platform scripts therefore close with a `verify` step that polls `/api/system/health` (`scripts/verify-server-health.js`) until it reports `ok` or the budget — `PORTOS_HEALTH_WAIT_MS`, default 120s — runs out. On failure they spend one more `pm2 start ecosystem.config.cjs` and then log the outcome loudly, with the manual recovery command.

The probe tries the loopback HTTP mirror (`:5553`) first, then the API port over HTTP and HTTPS, because the listening scheme depends on whether a cert is provisioned; `/api/system/health` is in the always-public set, so it works with the optional instance password on. The recovery only fires when the probe fails, so it cannot make a healthy update worse.

**When the probe still fails after the recovery, the scripts say so and exit non-zero** — the closing banner reads "Update applied, but PortOS is DOWN" instead of "Update Complete". The script outlives the server it restarts, so its exit status and the tail of `data/update.log` are the only signals a wrapper, a CI job, or an operator still has; printing a success banner over a confirmed-headless install is how the failure went unnoticed for hours in the first place.

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

## Running a customized fork

The `UpdateTab` fork panel states this in short form. The full loop is here, because that panel is
the only other place it exists and it renders only when `isFork` is true.

Keep `main` a clean mirror of upstream and never commit to it — that is what keeps `gh repo sync`
fast-forward and avoids 409 `FORK_DIVERGED`. Private changes live on their own branch, rebased
onto `main` after each sync. Anything shareable goes upstream as a PR instead, so you carry less
forward each time.

**PM2 boots whatever is checked out**, so the branch you are on is the code that runs. Staying on
your private branch is what makes your customizations live; there is no separate step.

### After rebasing, reinstall and rebuild

`update.sh` always finishes on `main`, so it cannot do this half for you:

```bash
git checkout main && ./update.sh
git checkout <your-branch> && git rebase main
for d in . client server autofixer; do (cd "$d" && npm install); done
npm run build && npm run pm2:restart
```

Order matters. `npm install` rewrites `client/package.json`, so building before installing leaves
the build stale again.

**A clean rebase makes the install look broken.** Checking out a branch based on an older `main`
rewinds the working tree, and the rebase rolls it forward, so every touched file gets a new mtime.
`getInstallState()` (`server/services/installState.js`) compares mtimes, so it reports a stale
build and stale deps in all four workspaces even though no dependency changed and no build input
was edited. The reinstall and rebuild above clear it.

## Image-bearing Persistent Mind work must drain before source transitions

The managed update route refuses to restart into a different source revision while a queued Persistent Mind message or active turn carries image references. `GET /api/update/status` reports the privacy-safe `persistentMindImages` preflight (`safe`, queued count, and active-turn boolean), and `POST /api/update/execute` re-checks it before and after acquiring the update lock.

To recover, drain the image-bearing messages, confirm the preflight is safe, create a normal PortOS backup, and retry the update. If a stopped or unavailable provider prevents the queue from draining, create a backup that includes `data/cos/state.json` and `data/screenshots/`, then explicitly retry the API request with `acknowledgePersistentMindImageBackup: true`; that acknowledgement is the recovery escape hatch and is never sent silently by the UI. Invalid or unreadable Persistent Mind state blocks the transition until it is restored from backup. Claimed historical images do not block updates once their message has completed. PortOS does not offer a managed rollback command; manually checking out an older source revision while image-bearing work is queued or active is unsupported because schema-v2 readers cannot preserve those references.
