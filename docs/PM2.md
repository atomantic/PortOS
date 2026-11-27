# PM2 process management

PortOS uses [`ecosystem.config.cjs`](../ecosystem.config.cjs) for process names,
runtime settings and [port assignments](PORTS.md). Run these commands from the
installation checkout.

| Command | Effect |
| --- | --- |
| `npm run pm2:start` | Start production apps and remove any old PortOS Vite process |
| `npm run dev` | Start development apps, including Vite on port 5554 |
| `npm run pm2:restart` | Restart production apps |
| `npm run pm2:stop` | Stop the PortOS processes managed by the ecosystem |
| `pm2 list` | List processes |
| `pm2 logs <process-name>` | Read one process's logs |

Use the ecosystem or the exact app name for changes. Global `pm2 kill`,
`pm2 delete all` and `pm2 restart all` affect unrelated apps in the shared daemon.
Use `pm2 save` when updating the process list that startup should restore.
See [startup troubleshooting](TROUBLESHOOTING.md) for failed boots.

## Managed applications

Use a repository-root `ecosystem.config.cjs` for CommonJS, including ESM
projects. Give every process a stable, app-prefixed name and set its script,
working directory and required environment. Define ports once and pass them
to the processes through their environment. Check for conflicts with PortOS
and other managed apps.

Set a graceful shutdown budget with `kill_timeout` when a worker needs time
to drain. Tune `max_restarts`, `min_uptime` and `restart_delay` for the process's
failure behavior. Set `wait_ready` only if the app sends its own ready event.
Use [App Wizard](features/app-wizard.md) to register and operate a managed app.
