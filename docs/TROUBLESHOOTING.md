# Troubleshooting Guide

## Startup Issues

Start with `npm run doctor` from the PortOS checkout:

```bash
npm run doctor
npm run doctor -- --json
```

The check is read-only and works before dependencies are installed. It reports each
prerequisite separately and exits with a nonzero status if a required check fails.
Optional checks include TLS certificates, `gh`, media tools and ports. A running
PortOS install normally occupies some ports in the 5553–5569 range. The report
omits hostnames, usernames, IP addresses and home directory paths.

### Port Already in Use

For `EADDRINUSE`, identify the listener before stopping anything. Port 5555 serves
production and the API. Port 5554 is the Vite development UI.

```bash
lsof -nP -iTCP:5555 -sTCP:LISTEN
lsof -nP -iTCP:5554 -sTCP:LISTEN
```

On Windows, use `Get-NetTCPConnection -LocalPort 5554,5555 -State Listen` to find
the owning process. If PortOS already owns the listener, inspect
`npm run pm2:status` before starting another copy. See [Port Allocations](PORTS.md).

### PM2 Process Not Starting

When PM2 shows `errored`, read the startup error:

```bash
npm run pm2:logs -- portos-server --lines 100
```

Check for missing dependencies, missing data files, a port conflict or an
unreachable database. Run `npm run install:all` from the primary checkout if
dependencies are missing.

### Missing Data Directory

For startup `ENOENT` errors in `data/`, seed missing files and restart:

```bash
npm run setup:data
npm run pm2:restart
```

`setup:data` preserves existing files, adds missing starter entries to provider
and prompt configuration, and leaves migration-owned outputs to the migrations.
Use this command to avoid overwriting your settings, app registrations,
provider configuration, CoS state, digital-twin documents and prompt templates
with the corresponding defaults in `data.reference/`.

## Connection Issues

### Cannot Access from Other Devices

Confirm both devices are on the same private Tailscale network and use the host's
Tailscale address on port 5555. Match the URL scheme to the host's configuration:
HTTP by default, HTTPS if certificates are configured. Check the local firewall
if loopback works but Tailscale access fails. Keep PortOS administration and
services private. See [Port Allocations](PORTS.md).

### WebSocket Disconnections

If real-time logs and CoS updates stop, check the browser console for Socket.IO
errors and run `npm run pm2:status`. Read the affected process's logs before
restarting it.

### Browser Console Warnings

For `contentscript.js` listener, `ObjectMultiplex`, or cross-world service-worker
preload warnings, check the console's source link and try a browser profile with
extensions disabled. If an extension causes the warning, update it or restrict
its site access.

If a page fails to render, check Network for failed JS or CSS requests. In
Chromium, temporarily enable **Application → Service Workers → Bypass for
network** to isolate caching and turn it off after the check. Include the browser
version and a redacted failing asset path when reporting a persistent failure.

## AI Provider Issues

### Codex rejects a model with a ChatGPT account

If Codex reports that a model is unsupported with a ChatGPT account, run
`codex login status` in the same environment as PortOS to check the active
authentication method. Choose an available model in the task or provider
settings. If you clear the task override, check that the provider's default
model is available to your account.

To pin the login method, go to **Models → Providers**, edit the Codex provider
and set **Codex authentication** to **ChatGPT subscription** or **API key**.
The default lets Codex choose. Switching to API-key authentication enables
separate metered billing. Keep the current login if the only issue is model
availability. Never share credential files or tokens.

### Claude Code CLI Not Found

If a run reports that `claude` could not be found, verify `claude --version` in
the environment that starts PortOS. If the CLI is missing, install it using
Anthropic's setup instructions. If it works in your terminal, check whether
the PortOS process can find the same executable on its PATH.

### API Key Errors

Confirm the run selected the intended provider under **Models → Providers**.
Check its saved credentials under **Settings → Credentials**, and verify that
the key is active and that the account can make requests. Claude Code CLI can
use its own authenticated session. Configure `ANTHROPIC_API_KEY` only if you
intend metered API-key billing.

### Model Not Found

Check the provider's current model identifiers and your account's access, then
match the task override or provider default to an available model. For Ollama,
check `ollama list` and pull the selected model if it is missing.

### Ollama context errors or truncated prompts

If a run reports `exceeds the available context size` or Ollama logs
`truncating input prompt`, compare the provider's configured window with the
loaded context shown in **Models → Runtimes** or `ollama ps`.

Set **Local num_ctx** under **Models → Providers → Edit → Generation → Context
Window**. PortOS uses that value for Ollama-backed CLI harnesses and sends it
via native Ollama chat for the Ollama API provider. Without a provider setting,
Ollama uses its daemon default, which can be set with `OLLAMA_CONTEXT_LENGTH`.
Increase the window in steps and check responsiveness after each change.
Larger contexts need more memory and can push part of the workload onto the CPU.

## Chief of Staff Issues

### CoS Not Running or Tasks Not Being Picked Up

If the CoS page shows **Stopped**, start it there and check the server logs if
it fails. Enable **Start on server boot** in CoS settings if you want it to
start with PortOS.
Create tasks through the UI or `POST /api/cos/tasks`. Check a pending task's
approval state, then trigger evaluation from the UI if needed.

### Agents Not Spawning

Check the runner and the selected provider:

```bash
npm run pm2:status
npm run pm2:logs -- portos-cos --lines 100
```

For CLI providers, check that the selected harness is installed and reachable
in the runner's environment. For API providers, check provider reachability
and credentials.

If every PTY agent fails with `posix_spawn failed: No such file or directory`
after dependency work, check for missing dependencies in the primary checkout.
An install inside a linked CoS worktree can empty the primary checkout's
dependency directory, including node-pty's spawn helper. Repair the primary
checkout and restart the runner from there:

```bash
node scripts/ensure-deps.js
node ./node_modules/pm2/bin/pm2 restart portos-cos
```

### Worktree Tests Load Stale Workspace Packages

If a managed repository uses npm workspaces and a worktree loads packages from
the primary checkout, check whether the worktree's `node_modules` is one
symlink pointing at the primary checkout. Remove only that confirmed symlink
and run the following from the PortOS checkout:

```bash
node scripts/link-worktree-deps.js <primary-checkout> <worktree>
```

This links shared dependencies and resolves workspace packages inside the
worktree when needed. Never run `npm install` or `npm ci` through linked
dependency paths. The managed `dependency-updates` task gets an isolated
dependency tree.

### Agent Uses the Wrong Workspace

In **Apps**, edit the selected app and check that **Repository Path** points at
an existing repository directory on the PortOS host. Compare it with
`Agent workspace` in the CoS task log or the working directory in the provider
run log. Set a valid path and rerun a blocked task. If the task does not belong to
an app, clear its app selection.

### Repository Path Is Outside Allowed Directories

If an app's **Submodules** tab or another repository operation returns
`path is outside allowed directories`, check the repository path against the
allowed roots. macOS permits external volumes under `/Volumes`. Windows permits
non-system lettered drives and can use a mapped drive for a network share.

For a repository outside the default roots, set `PORTOS_WORKSPACE_ROOTS` to the
needed directories. Separate entries with `;` on Windows and `:` on macOS or
Linux. The setting scopes filesystem access for repository routes.

### Memory Search Returns No Results

Select a backend and 768-dimensional model under **Models → Embeddings** and
save the settings. Check the embedding status at `GET /api/memory/embeddings/status`
if embeddings still fail.

## PM2 Issues

### Process Keeps Restarting

Read the process's logs for crashes, missing settings or memory restarts:

```bash
npm run pm2:logs -- portos-server --lines 200
```

Use `node ./node_modules/pm2/bin/pm2 monit` to inspect memory. If the server
regularly hits its PM2 ceiling during expected work, adjust
`PORTOS_SERVER_MAX_MEMORY` in `.env` and restart PortOS.

### Stop PortOS on a Shared PM2 Daemon

Use `npm run pm2:stop` to stop the PortOS ecosystem. Daemon-wide commands such
as `pm2 kill` or `pm2 delete all` also affect other managed apps.

### Old Code Running After Changes

For development, run `npm run dev`. To serve a fresh production build, run
`npm start` from the primary checkout.

## Database/Data Issues

### Server Won't Boot: Database Unreachable

PortOS requires PostgreSQL. Check whether the configured PostgreSQL service
responds. Native setups use port 5432 by default. Docker setups use port 5561.

```bash
pg_isready -h localhost -p 5432
pg_isready -h localhost -p 5561
```

Start the configured PostgreSQL service, or run `npm run setup:db` if database
provisioning is incomplete. See [Storage](STORAGE.md).

### Missing or Corrupted Records

Check the **Database** settings tab for relational records such as universes,
catalog entries and memories. Recover them from a snapshot using the **Backup**
tab. Save a fresh backup of the current state before restoring older data.
See [Backup and Restore](BACKUP.md).

For missing gallery collection items, check whether an unaffected peer or
backup still holds the membership. Restore the items and reselect the pinned
cover if needed. Media bytes can live on a peer, so missing local files alone
do not establish that a collection item was deleted.

### Another Migration Run Holds `data/migrations.lock`

Let the active runner finish and retry. If needed, stop PortOS with
`npm run pm2:stop` and confirm no manual `npm run migrations` is active.
A subsequent run can reclaim a lock whose recorded process has exited.
If a crash left a lock stuck in the release transition, remove
`data/migrations.lock` manually only after confirming every migration runner
has stopped. Keep `data/migrations.applied.json` intact.

### Lost App Registrations or History

Check that `data/apps.json` and `data/history.jsonl` exist, that PortOS can write
to them and that the disk has free space. If the app registry is damaged,
restore it from a backup or recreate the registrations in **Apps**.

### Recovering a store with an orphaned `.bak` file

When PortOS reports a missing store with a `<name>.*.bak` sibling, choose the
recovery copy yourself:

1. Stop PortOS and any other writers to the data directory.
2. Preserve all `.bak` and `.tmp` siblings while you inspect the backups.
3. Copy the backup that holds the intended state to the canonical filename,
   such as `settings.json`. Leave the backup copies in place.
4. Restart PortOS and verify the recovered state before removing leftover
   backups.

On Windows, a write can fail with a message that the file stayed locked and
the existing file was left untouched. Wait for the lock to clear and retry the
original action.

## Performance Issues

### Slow UI or Agents Page

Compare local and remote access to isolate network latency. For a slow Agents
page, check PortOS logs for PM2 timeouts or slow CoS state operations and reduce
concurrent heavy work if the host is busy. If the problem persists, report the
timing and redacted log lines around a stall.

If large logs are consuming disk space, save the relevant diagnostics before
clearing a specific process's logs with
`node ./node_modules/pm2/bin/pm2 flush portos-server`. An unscoped flush clears
logs for other apps on the same daemon.

### Agent Runs Timeout

Check provider connectivity and log output. Split long tasks into smaller
pieces or increase the selected provider's timeout if the work needs longer.

## Update Issues

### Git Reports a Stale Submodule Lock

If setup or update fails with `index.lock: File exists`, run `npm run doctor`
and check whether a Git process is still working on the repository. Linked
worktrees share submodule locks, so check activity across them. Retry the
normal PortOS update after the process exits. If automatic recovery leaves a
confirmed stale lock, remove only the lock named in the error and rerun
`git submodule update --init --recursive`.

## Local Media Issues

### macOS Reboots During Local MLX Video Renders

If the macOS crash report shows a GPU watchdog timeout while an MLX video
render is active, enable **Sleep display during local MLX video renders** in
**Create → Media Gen → Settings → Defaults** or enable it for that render.
The setting keeps the system awake during rendering. You can also use
`pmset displaysleepnow` after starting a render, or run headless over SSH.
Update macOS and the MLX runtime if the panic persists.

## Getting Help

- Run `npm run doctor` and note the steps that reproduce the problem.
- Collect the relevant lines from `npm run pm2:logs` or the browser console.
  Redact private hostnames, identifiers, credentials and record contents.
- Include your PortOS version and operating system when you
  [open a GitHub issue](https://github.com/atomantic/PortOS/issues).
