# Managed app update contract

PortOS updates itself through `update.sh` or `update.ps1`. That lifecycle is
specific to PortOS and is never assumed for a separately managed app.

When a managed app is updated, PortOS first fetches `origin`, checks out that
repository's default branch, fast-forwards it, and restarts the app's configured
PM2 processes. It does not automatically run `npm install`, `setup`, migrations,
or a production build. If the checkout has local changes, the update stops
without stashing or discarding them.

An app can opt into its own lifecycle in either of these ways:

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
launcher: the conventional-script branch delegates to `executeUpdate()` in
`server/services/updateExecutor.js`, whose double-fork keeps `update.sh` alive
through its own `pm2 delete` step, and the trailing PM2 restart is skipped
because the script starts the ecosystem itself. See
[Self-Update Flow](SELF_UPDATE.md#every-portos-update-goes-through-the-detached-launcher).

A custom **Update Command** on the PortOS record keeps the ordinary attached
path, since delegating would silently run `update.sh` instead of the configured
command.
