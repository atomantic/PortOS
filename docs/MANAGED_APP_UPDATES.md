# Managed app update contract

PortOS updates itself through `update.sh` or `update.ps1`. That lifecycle is
specific to PortOS and is never assumed for a separately managed app.

When a managed app is updated, PortOS fetches `origin` and checks out the
repository's configured `portos.runtimeBranch`, or origin's default branch when
that setting is absent. It first tries `git pull --ff-only origin <branch>`.
If that fails, it retries with `git pull --rebase --autostash origin <branch>`:
local commits can be rebased, and tracked uncommitted changes can be temporarily
stashed and reapplied. Local changes do **not** automatically stop an update;
non-conflicting changes can also carry across the branch switch. Commit work
before updating if you need a durable recovery point, and preserve untracked
files separately — `--autostash` is not an untracked-file backup.

A blocked checkout, failed rebase, or conflict while reapplying the autostash
stops the update before lifecycle commands or process restart. PortOS attempts
to abort a failed rebase and queues a CoS conflict-resolution task. An autostash
reapply conflict can leave unmerged files after the rebase has completed; the
update does not treat Git's zero exit status as success in that case. Review
the reported conflict and task outcome before retrying. Configured companion
repositories follow the same pull sequence; a later conflict does not roll
back repositories already updated.

After successful pulls, PortOS runs any opted-in lifecycle below and restarts
the app's configured PM2 processes. Without that lifecycle, it does not
automatically run `npm install`, `setup`, migrations, or a production build.

An app can opt into its own lifecycle in these ways:

1. Add an executable `update.sh` (or `update.ps1` on Windows) at the repository
   root. PortOS recognizes these conventional scripts automatically.
2. Set **Update Command** in Apps → Edit → Commands (for example,
   `npm run update`). Commands use PortOS's normal command allowlist and run
   from the app repository root.
3. For Node or Bun apps, define a dedicated package script named
   `portos:update`. PortOS runs it as `npm run portos:update` or
   `bun run portos:update` for Bun-managed apps.

The command/script is responsible for the app's own dependency installation,
database migrations, generated assets, and build. Use the dedicated
`portos:update` name rather than a generic lifecycle hook so an app's normal
package-manager behavior is never invoked merely because PortOS updated it.
When more than one is present, the configured **Update Command** wins, then
`portos:update`, then the conventional script.

## PortOS is itself a managed app

The PortOS record appears in App Management like any other app, so **Update**
there runs the same `appUpdater` flow described above. It is the one app whose
update routine deletes the process running that flow, so it takes a different
launcher: when the record points at the running PortOS checkout and uses its
conventional update script, it delegates to `startPortosSelfUpdate()` in
`server/services/portosSelfUpdate.js` with mode `refresh`. The shared detached
launcher keeps the update alive through its own PM2 shutdown. The trailing
PM2 restart is skipped because the script starts the ecosystem itself. See
[Self-Update Flow](SELF_UPDATE.md#every-portos-update-goes-through-the-detached-launcher).

A custom **Update Command** on the PortOS record keeps the ordinary attached
path, since delegating would silently run `update.sh` instead of the configured
command.
