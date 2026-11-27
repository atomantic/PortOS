# Self-Update Flow

PortOS checks upstream releases and updates from the configured origin. Forks keep their independent history and configuration.

## Manual and automatic updates

Use **Update Now** for a newer release, **Reconcile Now** for an out-of-sync installation, or the managed app's **Update app** action to refresh after advancing its checkout. Terminal entry points are `bash update.sh`, `./update.ps1` and `npm run update`.

Manual updates close intake, stop PortOS before source/dependency changes and recheck executing work under the hold. If current work would be interrupted, the UI or terminal requests explicit consent. For a noninteractive run, `--interrupt` supplies that consent. Interrupted work retains failure or recovery evidence, and queued durable jobs stay queued. An active database maintenance operation, live installer, surviving runtime or unsafe checkout can still block the update.

If an older UI cannot show the continuation, open the confirmation URL printed in the waiting step on the same instance and sign in. The URL is bound to its attempt and checkout. If the old server refuses to launch fresh scripts, **Dev Tools → Runner → Command** in the PortOS workspace can invoke `node scripts/manual-update-recovery.mjs --request`. That uses the normal path and retains interruption consent checks.

## Releases, origin and forks

Release polling always reads upstream `atomantic/PortOS`. Use `server/lib/gitRemote.js` for upstream identity and local `remoteInfo` classification. The scripts update the local `main` branch from origin. A clean checkout can move to `main` without deleting another branch. The scripts refuse dirty checkouts and do not stash. Submodules advance to parent-pinned gitlinks only, preserving edits, untracked work and independently advanced commits.

The Update tab distinguishes **Sync Fork & Update**, **Sync Fork Only**, and **Update from Fork As-Is**. Server-side fork sync fast-forwards from upstream and returns `FORK_DIVERGED` on divergence. Never pass `--force`. Keep a customized fork's changes on a separate branch if using upstream fast-forward sync, then rebase that branch and rebuild dependencies and the client before restarting it. PM2 boots the checked-out code.

## Every PortOS update goes through the detached launcher

The service entry points share `startPortosSelfUpdate()` and the detached launcher. Direct scripts and service launches enter `scripts/deferred-update.mjs` before touching git, logs or PM2. A waiting operation leaves admission open until it can take the maintenance hold atomically. A manual or peer maintenance hold superseding a waiting update cancels that update without releasing the new owner. A retry can replace only an older waiting supervisor that has no worker or hold.

The supervisor survives server restart and records ordered `STEP:` progress and terminal status. POSIX settlement also proves process-group completion. Windows uses a detached console-less supervisor and requires operation-specific terminal evidence. A console close or forced kill can leave a hold pending. A missing process or timeout alone cannot settle ownership. With the API offline, `node scripts/deferred-update.mjs --recover` reconciles update ownership. For workflow publication and inactive-reservation recovery, see [Storage](STORAGE.md#workflow-maintenance-journal).

The managed app receives launch acceptance while the supervisor is still running. Its UI follows the progress and restart watcher. A raw socket disconnect and a successful spawn are insufficient to establish a restart.

## Post-update health verification

The updater verifies `/api/system/health` after starting the production PM2 apps, beginning with the loopback HTTP mirror when available. If the probe cannot confirm healthy startup, it attempts the production restart recovery and probes again. A remaining failure exits nonzero and records diagnostic guidance in `data/update.log`. A trigger tag, an old marker or a launch that never emitted progress cannot prove success.

## Automatic updates (unattended, idle-gated)

The opt-in Update tab setting selects release or main. The scheduler uses the corresponding manual implementation and dispatches only when cooldown, update availability, checkout readiness and system idleness all pass. The default cooldown is six hours. It records launch before restart and persists the latest skip reason for the panel.

Renders and jobs, running or queued CoS work, Persistent Mind turns/messages, app operations and unresolved ownership can block the idle gate. Unreadable activity is not proof of idleness. Readiness can switch a clean branch back to the default, restore approved generated lockfile drift, or repair a clean stale submodule ancestor to the pinned revision. Local commits, staged gitlinks, conflicts and untrusted state remain protected. The optional agent escalation is deduplicated and off when the operator disables it.

## Node.js runtime and dependencies

The Update tab reports the running Node version and supported alternatives, plus the shipped, daemon and global PM2 versions. An authorized Node switch requires idle state, pins the selected interpreter in `PORTOS_NODE_INTERPRETER` and uses the normal detached refresh path. The PM2 sync action aligns an older daemon or global CLI to the shipped version.

The server workspace supplies PM2 for startup, updates and the root `pm2:*` commands. During the first update from an older release, the updater can create a compatibility link at the previous CLI location so it can complete the restart with the server copy.

Workspace dependencies can be reused when the install receipt, manifests, lockfile, project npm configuration and installed packages agree. Stale or unknown state triggers repair. Trusted native rebuilds, client build, restart and verification still run. A primary-install update is separate from dependency linking in a CoS worktree.

## Image-bearing Persistent Mind work must drain before source transitions

The update preflight and the detached script both refuse while a queued message or active turn carries image references. Drain the work, verify preflight, take a normal backup, then retry. When a stopped provider prevents draining, back up `data/cos/state.json` and `data/screenshots/` before explicitly passing `acknowledgePersistentMindImageBackup: true` or `PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED=1` for a direct launch. Unreadable persisted state still blocks the transition. Rolling back manually with live image references is unsupported.

## Verifying a change to the updater itself

Use a disposable install with its own service ports, DB and PM2 state. Record the starting commit, runtime versions, healthy endpoint, PM2 state and a restorable snapshot. First run the old updater into the candidate, then run the installed candidate into a content-identical descendant. Verify ordered progress, exact checkout, completion evidence and live health after each. Retain the logs and restore the disposable snapshot on failure.
