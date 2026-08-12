# Self-Update Flow

How PortOS notices a new release and updates itself. PortOS is distributed software — many people run it, and a large share run it from a **personal fork**, so every step here is fork-aware. Breaking that assumption produces silent no-op updates.

Code: `server/services/updateChecker.js`, `server/routes/update.js`, `server/lib/gitRemote.js`, `update.sh` / `update.ps1`, `client/src/components/settings/UpdateTab.jsx`.

## Release polling always targets upstream

The release-notification poll **always queries the upstream `atomantic/PortOS`** repo, so a user running from a fork still sees new upstream versions. The constants come from `server/lib/gitRemote.js` (`UPSTREAM_OWNER`, `UPSTREAM_REPO`, `UPSTREAM_FULL_NAME`) — do not re-hardcode the upstream slug anywhere else.

## Classifying the local remote

`getOriginInfo()` in `server/lib/gitRemote.js` classifies the local `origin` remote into `{ isUpstream, isFork, isGithub, owner, repo, fullName }`. `getUpdateStatus()` returns this as `remoteInfo`, alongside a fixed `upstream` block.

**New UI that says "you are running PortOS" must read `remoteInfo.isUpstream`, not just `currentVersion`** — otherwise it lies to fork users.

## Pulling: origin, not upstream

`update.sh` / `update.ps1` always `git pull --rebase --autostash` from **origin**. A fork user who has not merged upstream into their fork gets a silent no-op pull.

To prevent that confusion, `POST /api/update/execute` rejects fork runs with **412 `FORK_SYNC_REQUIRED`** unless either:

- the request body sets `acknowledgeFork: true`, or
- `lastForkSync.fullName` matches `remoteInfo.fullName` and is less than 10 minutes old.

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
