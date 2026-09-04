# Self-Update Flow

How PortOS notices a new release and updates itself. PortOS is distributed software — many people run it, and a large share run it from a **personal fork**, so every step here is fork-aware. Breaking that assumption produces silent no-op updates.

Code: `server/services/updateChecker.js`, `server/services/portosSelfUpdate.js`, `server/services/updateExecutor.js`, `server/services/appUpdater.js`, `server/routes/update.js`, `server/lib/gitRemote.js`, `server/lib/detachedSpawn.js`, `update.sh` / `update.ps1`, `scripts/verify-server-health.js`, `client/src/components/apps/tabs/UpdateTab.jsx`, `client/src/hooks/usePortosRestartWatch.js`, `client/src/hooks/useAppOperation.js`.

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

**Windows needs the same escape, and cannot get it from `detached: true`.** PM2 kills there with `taskkill /pid <app> /T /F`, which walks the identical parent→child tree, so an attached `update.ps1` dies at `pm2-stop` exactly as an attached `update.sh` would. But Node's `detached: true` maps to **`DETACHED_PROCESS`** on Windows, which denies the child a console — and a console host like `powershell.exe` given no console exits **0 within ~100ms without running a single line**. That combination is why the in-app update silently did nothing on Windows while reporting a successful update to the target release (#6169): the script never ran, `executeUpdate` saw exit 0, and stamped the triggering tag onto a "Success" result. So on Windows `spawnDetached` launches a short-lived PowerShell launcher that `Process.Start`s a **supervisor** (with `CreateNoWindow`, per [WINDOWS_CONSOLE.md](WINDOWS_CONSOLE.md)) and exits. The supervisor's parent is then gone, so `taskkill /T` from the server never reaches it; it redirects the script's output into the control dir and records its pid and exit status there, so the same tailer streams `STEP:` progress on both platforms. This is the *only* win32 path — it shipped in #6169 behind a `windowsDetached` opt-in, because the plain-spawn fallback beside it handed back a real `ChildProcess` whose `kill` tree-killed the job's own descendants and the supervisor path could then only signal the job's pid; #6170 routed the supervisor handle's `kill` (and the boot-time orphan reaper) through the same `taskkill /T /F`, which removed the trade-off and with it the option.

Two guards keep a launch that did nothing from being reported as an update:

- A run that exits 0 having emitted **no `STEP:` line at all** is recorded as a failure, not a success — both scripts emit `git-pull:running` before touching anything, so silence means the script never ran.
- When `data/update-complete.json` is missing (usually because the restarted server already consumed it), the recorded version comes from **package.json on disk**, never from the triggering tag: the tag is only what the update aimed at.

**PortOS is also a managed app**, so an update started from **App Management**'s Git tab reaches `update.sh` through `appUpdater.js` rather than `routes/update.js`. Both entry points call the same `startPortosSelfUpdate()` (`server/services/portosSelfUpdate.js`), which owns the whole lifecycle: the preflight refusals, the atomic `setUpdateInProgress(true)` lock, the post-lock re-check, and the `executeUpdate()` launch. They differ only in `mode`:

| Surface | Mode | Gate |
|---|---|---|
| Update page — "Update Now" | `release` | needs a newer release tag |
| Update page — "Reconcile Now" | `reconcile` | needs `installState.outOfSync` |
| App Management — "Update app" | `refresh` | none; the caller has already advanced the checkout onto its origin default branch |

`refresh` exists because App Management moves HEAD before handing off. Gating it on out-of-sync would only re-ask whether the pull it just did happened — and that same pull makes `update.sh`'s own `git pull` a no-op, so the script's commit-diff dependency detection sees nothing. The launcher therefore passes `installState`'s stale workspaces through as `forceCleanWorkspaces` for both non-release modes, which is what keeps deps from surviving the update (#1779).

The socket path runs `checkPortosUpdatePreflight` itself before it pulls — a refusal must land before the checkout moves, and its `code` is what the panel's acknowledge-and-retry buttons key on — then passes `preflightAlreadyRun` so the launcher reads a fresh `getUpdateStatus()` (post-pull, for the stale workspaces) without re-running guards that already answered. The post-lock re-check is authoritative for both callers either way.

Because the lock is taken in one place, the two entry points cannot run `update.sh` concurrently — and because that flag is what `subAgentSpawner`, `agentLifecycle` and `persistentMindSupervisor` gate on, holding it also stops a CoS agent from being spawned into a process the script is about to `pm2 delete` (#4124).

`appUpdater` also **skips its own `restart` step** for that case: the script runs `pm2 start ecosystem.config.cjs` itself, so restarting on top of it would be redundant and would race the script.

### Nothing awaits the script, on either side

`startPortosSelfUpdate()` resolves as soon as the detached script is RUNNING. It cannot report the outcome, because `update.sh` `pm2 delete`s this server partway through and the process awaiting it dies there — an awaited launch simply never runs its own completion code. The Git tab used to await it, which is why it hung: `app:update:complete` never fired, the operation was never cleared, and the row sat on "Stopping PortOS apps..." forever while the update finished fine in the background. So `appUpdater` returns `{ selfUpdateStarted: true }` at the launch, and `server/sockets/apps.js` deliberately **leaves the operation registered** and emits no completion — the map dies with the process, and the remaining `STEP:` frames keep rendering right up to the moment the server goes down.

The client half of that contract is `usePortosRestartWatch` (`client/src/hooks/usePortosRestartWatch.js`). **App Management surfaces do not wire it themselves** — `useAppOperation` owns it and exposes `restarting`, so every caller of `startUpdate` inherits the baseline capture and the restart detection and a new surface cannot regress to the hang by forgetting them. The Update page, which does not go through an app operation, uses the hook directly. It arms on the update stream's `restart` step, on `portos:update:complete`, or on a socket `disconnect` **confirmed unreachable** (a raw disconnect is not proof — PortOS is commonly used remotely over Tailscale, and a network blip fires one too). Once armed it polls `/api/system/health` and reloads on a version change, a down→up dip, or an uptime reset below the pre-update peak — three signals, because a reconcile often lands the same version and its restart can be too fast to sample the down window.

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

`update.sh` / `update.ps1` always finish on `main`, so they cannot do this half for you:

```bash
git checkout main && ./update.sh            # .\update.ps1 on Windows
git checkout <your-branch> && git rebase main
for d in . client server autofixer; do (cd "$d" && npm install --no-save); done
node scripts/trusted-rebuilds.js server
npm run build && npm run pm2:restart
```

**Use `--no-save`, not a bare `npm install`.** `--no-save` is what `safe_install` in `update.sh`
and `scripts/ensure-deps.js` run, for two reasons that both bite a fork: a bare install rewrites
`client/package.json` and the lockfiles, which dirties your private branch and re-stales a build
you just made (`client/package.json` is a `staleBuild` input — see below); and an older npm can
strip newer lockfile metadata it does not understand. `--no-save` still honors `package-lock.json`.

`scripts/trusted-rebuilds.js` is not optional for the server. Every workspace `.npmrc` sets
`ignore-scripts=true`, so the server's native addons (`node-pty` and friends) are never built by
the install itself — skip the rebuild and the shell and TUI features crash on a missing binding.

Order matters: install before you build, so the build sees the deps it compiles against.

**A clean rebase makes the install look broken.** Checking out a branch based on an older `main`
rewinds the working tree, and the rebase rolls it forward, so every touched file gets a new mtime.
`getInstallState()` (`server/services/installState.js`) compares mtimes, so it reports a stale
build and stale deps in all four workspaces even though no dependency changed and no build input
was edited. The reinstall and rebuild above clear it.

## Image-bearing Persistent Mind work must drain before source transitions

The managed update route refuses to restart into a different source revision while a queued Persistent Mind message or active turn carries image references. `GET /api/update/status` reports the privacy-safe `persistentMindImages` preflight (`safe`, queued count, and active-turn boolean), and `POST /api/update/execute` re-checks it before and after acquiring the update lock.

To recover, drain the image-bearing messages, confirm the preflight is safe, create a normal PortOS backup, and retry the update. If a stopped or unavailable provider prevents the queue from draining, create a backup that includes `data/cos/state.json` and `data/screenshots/`, then explicitly retry the API request with `acknowledgePersistentMindImageBackup: true`; that acknowledgement is the recovery escape hatch and is never sent silently by the UI. Invalid or unreadable Persistent Mind state blocks the transition until it is restored from backup. Claimed historical images do not block updates once their message has completed. PortOS does not offer a managed rollback command; manually checking out an older source revision while image-bearing work is queued or active is unsupported because schema-v2 readers cannot preserve those references.
