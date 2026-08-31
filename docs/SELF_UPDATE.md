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

## Image-bearing Persistent Mind work must drain before source transitions

The managed update route refuses to restart into a different source revision while a queued Persistent Mind message or active turn carries image references. `GET /api/update/status` reports the privacy-safe `persistentMindImages` preflight (`safe`, queued count, and active-turn boolean), and `POST /api/update/execute` re-checks it before and after acquiring the update lock.

To recover, drain the image-bearing messages, confirm the preflight is safe, create a normal PortOS backup, and retry the update. If a stopped or unavailable provider prevents the queue from draining, create a backup that includes `data/cos/state.json` and `data/screenshots/`, then explicitly retry the API request with `acknowledgePersistentMindImageBackup: true`; that acknowledgement is the recovery escape hatch and is never sent silently by the UI. Invalid or unreadable Persistent Mind state blocks the transition until it is restored from backup. Claimed historical images do not block updates once their message has completed. PortOS does not offer a managed rollback command; manually checking out an older source revision while image-bearing work is queued or active is unsupported because schema-v2 readers cannot preserve those references.
