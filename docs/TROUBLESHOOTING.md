# Troubleshooting Guide

Common issues and solutions when running PortOS.

## Codex rejects a model with a ChatGPT account

**Symptom**: `The 'example-model' model is not supported when using Codex with a ChatGPT account.`

This is a model-access rejection, not evidence that login failed. Run
`codex login status` in the same environment as PortOS to confirm the active
authentication method. PortOS lets Codex own its credentials and token refresh.

To pin which login method PortOS uses, set **Codex authentication** on the Codex provider
(AI Providers → edit): *ChatGPT subscription* or *API key*. It passes
`-c forced_login_method=...` to Codex; leave it on the default to let Codex decide.

Choose a supported model in the task or provider settings, or clear the task's
model override to use its configured default (check that default too). PortOS's
shipped model catalog can include models unavailable to your account; refreshing
the catalog alone does not prove entitlement. A quiet-session continuation cannot
fix an unsupported model selection.

ChatGPT subscription access and API-key access are separate authentication and
billing modes. Do not re-login or replace credentials merely to fix this message.
If API billing is intended, configure it explicitly using the
[official Codex authentication instructions](https://learn.chatgpt.com/docs/auth).
Never paste credential files or tokens into an issue.

## Startup Issues

### Start Here: `npm run doctor`

**Symptom**: anything won't start, and it isn't obvious which prerequisite is missing.

```bash
npm run doctor          # human-readable table
npm run doctor -- --json  # { ok, facts: [{ name, status, detail, required }] }
```

It is read-only (no installs, no migrations, no DB writes) and loads from a bare
checkout, so it works even before `npm install` has ever run. Each prerequisite
is probed independently and separately bounded, so one unreachable service
degrades to a single line instead of hanging the report. It exits non-zero when
a **required** prerequisite is unavailable; optional facts (TLS cert, `gh`,
ffmpeg/python3/uv, the port block) are reported but never fail the run — a
running install legitimately occupies ports in the PortOS band, 5553–5569.

Details name no hostnames, usernames, IPs, or home-directory paths, so the
output is safe to paste into a bug report as-is.


### Port Already in Use

**Symptom**: Server fails to start with `EADDRINUSE` error.

**Solution**:
```bash
# Find what's using the port (:5554 is only used by npm run dev)
lsof -i :5554
lsof -i :5555

# Kill the process or choose different ports in ecosystem.config.cjs
```

### PM2 Process Not Starting

**Symptom**: `npm run pm2:start` shows a process but status is `errored`.

**Solution**:
```bash
# Check PM2 logs for errors
npm run pm2:logs -- portos-server --lines 100

# Common causes:
# - Missing dependencies: npm run install:all
# - Missing data directory or files: npm run setup:data (see below)
# - Port conflict: check EADDRINUSE errors
```

### Missing Data Directory

**Symptom**: Server crashes with `ENOENT` errors about files in `data/`.

**Solution**:
```bash
# Seed only what is missing — never overwrites an existing file
npm run setup:data
npm run pm2:restart
```

`setup:data` (`scripts/setup-data.js`) creates `data/` from `data.reference/` when it is absent. Otherwise it copies only the missing files, adds new starter entries to `providers.json` and the prompt configs without touching yours, and expands `__PORTOS_ROOT__` in `apps.json`. It also skips any path a migration derives from your own records (`scripts/lib/migrationOwnedPaths.js`). Pending migrations run when the server boots.

**Never copy `data.reference/` over `data/` by hand** (`cp -r data.reference/* data/`). The seed tree includes `settings.json`, `apps.json`, `providers.json`, `cos/state.json`, Brain settings (`brain/meta.json`), the digital-twin documents and every prompt template. Copying it overwrites your copies of all of them with shipped defaults, and nothing reports what was lost.

### Dynamic import callback missing after profiling

**Symptom**: `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`, followed by an unhandled
rejection whose original stack names `Timeout._onTimeout (<anonymous>:…)`, near
`Debugger attached` / `Debugger ending` messages.

Inspect the original stderr stack, not only the normalized `ServerError` stack.
A profiler cleanup expression injected through Node's inspector can cause this:

```js
setTimeout(() => import('node:inspector').then(m => m.close()), 500);
```

The timer's dynamic import can run without an import callback in that evaluation
context. Its rejected promise escapes the timer, and the inspector stays open.
An acknowledged `Runtime.evaluate` request only proves the timer was scheduled;
even `awaitPromise: true` cannot await a promise that the timer callback later
creates. This pattern alone does not indicate a broken application import.
See Node's [VM import callback documentation](https://nodejs.org/api/vm.html#when-the-importmoduledynamically-option-is-not-specified-or-undefined).

**Solution**: after stopping your profiling session, use synchronous builtin
access in the inspector's `Runtime.evaluate` expression:

```js
setTimeout(() => process.getBuiltinModule('node:inspector').close(), 500);
'cleanup scheduled';
```

`process.getBuiltinModule` is available on PortOS's supported Node versions and
does not depend on the evaluation context's ESM loader. Check the response with
the matching protocol request ID for both a protocol `error` and
`result.exceptionDetails` before disconnecting your debugger socket. After the
delay, verify that the same loopback inspector listener is closed and the server
remains healthy with no new rejection. Closing the debugger socket alone leaves
the inspector listener running. Close only the inspector session you own; do not
restart the live server or change application VM sandbox loaders to repair a
profiling expression.

## Connection Issues

### Cannot Access from Other Devices

**Symptom**: PortOS works on localhost but not from phone/tablet.

**Causes and Solutions**:

1. **Tailscale not connected**: Ensure both devices are on same Tailscale network
2. **Firewall blocking**: Check local firewall allows port 5555. Port 5554 is needed only while `npm run dev` is running.
3. **Server bound to localhost**: PortOS should bind to 0.0.0.0 (default)

```bash
# Verify server is listening on all interfaces
netstat -an | grep 5555
# Should show: *.5555 or 0.0.0.0:5555
```

### WebSocket Disconnections

**Symptom**: Real-time features (logs, CoS updates) stop working.

**Solution**:
- Check browser console for WebSocket errors
- Verify server is running: `npm run pm2:status`
- Restart server: `npm run pm2:restart`

## Browser Console Warnings

### `contentscript.js` listener and `ObjectMultiplex` warnings

**Symptoms**: `MaxListenersExceededWarning` for 11 `close` or `end` listeners,
alongside orphaned `app-init-liveness` or `background-liveness` streams.

This combination matches [MetaMask's reported extension issue](https://github.com/MetaMask/metamask-extension/issues/43090).
Confirm the source by clicking the console's script link: a
`chrome-extension://` URL identifies extension code, rather than a PortOS bundle.
The warning alone does not establish a PortOS memory leak. Raising PortOS's
EventEmitter listener limit would not repair the extension's emitter.

Reload PortOS in a fresh browser profile with no extensions to isolate the
cause. An incognito window only serves this purpose if no extensions are allowed
there. If the warnings disappear, update the identified extension or restrict
its site access to sites where it is needed, then reload the original tab.

### Preload rejected with a cross-world service worker resource mismatch

Chromium refuses to reuse a service-worker response across different script
worlds (such as the page and an extension's isolated world). This is a browser
isolation check, distinct from an incorrect preload `as` attribute; see
[Chromium's resource reuse checks](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/loader/fetch/resource.cc).
An accompanying unused-preload warning can be a consequence of that rejection.
Neither warning by itself means the app's script failed to load.

PortOS intentionally uses Vite's module preloads and a service worker for its
offline shell and cached build assets. First compare the same page in a profile
without extensions. If the warning persists, temporarily select **Application >
Service Workers > Bypass for network** in Chromium DevTools and reload to
isolate service-worker involvement; turn the bypass off afterward. Do not
permanently disable preloads or offline caching just to suppress a warning.

If the page fails to render, inspect Network for failed JS/CSS requests and the
console for an actual import/load error. Record the browser version, whether
extensions and service-worker bypass change the result, and a redacted failing
asset path. Remove private hostnames, record identifiers, and credentials before
sharing diagnostics. The warning text alone cannot identify which extension or
request caused the preload mismatch.

## AI Provider Issues

### Claude Code CLI Not Found

**Symptom**: DevTools runs fail with "command not found".

**Solution**:
```bash
# Install Claude Code globally
npm install -g @anthropic-ai/claude-code

# Verify installation
which claude
claude --version
```

### API Key Errors

**Symptom**: AI runs fail with authentication errors.

**Solution**:
1. Check provider configuration in PortOS Settings
2. Verify API key is valid and has credits
3. For Claude: ensure `ANTHROPIC_API_KEY` is set

### Model Not Found

**Symptom**: Error "model: xyz not found" or similar.

**Solution**:
- Verify model name matches provider's available models
- Check provider documentation for correct model identifiers
- Common models:
  - Claude: `claude-sonnet-5`, `claude-opus-5`, `claude-haiku-4-5-20251001`
  - OpenAI: `gpt-5`, `gpt-5-mini`
  - Ollama: Model must be pulled first (`ollama pull llama3`)

### Ollama-backed agent dies with "exceeds the available context size"

**Symptom**: a Claude Ollama / OpenCode Ollama session works for a while, then
stops with

```
API Error: 400 {"error":{"code":400,"message":"request (32768 tokens) exceeds the
available context size (32768 tokens), try increasing it",
"type":"exceed_context_size_error","n_prompt_tokens":32768,"n_ctx":32768}}
```

**Cause**: Ollama picks a model's runtime window from available VRAM
(`OLLAMA_CONTEXT_LENGTH` documents the default as "4k/32k/256k based on VRAM"),
so a 256K-capable model is commonly *loaded* at 32K. An agent harness ships a
system prompt, tool schemas, and a growing transcript, and sizes its own
compaction against the window it thinks it has — so it overruns the real one
without warning. The task isn't too big; the window is too small.

**Solution**: set **Local num_ctx** on the provider (AI Providers → the provider
→ Context Window). PortOS reloads the Ollama daemon at that window before the
next run, because a CLI/TUI harness talks to Ollama directly and nothing else
can raise it. `OLLAMA_CONTEXT_LENGTH` in the environment works as a machine-wide
fallback.

The shipped `claude-ollama` / `claude-ollama-tui` records already pin 128K, so
this usually bites the OpenCode Ollama harnesses or a record whose window was
cleared. Note the precedence: a record's **Local num_ctx** wins over
`OLLAMA_CONTEXT_LENGTH`, so on a machine where 128K does not fit, lower it on
the record rather than only in the environment.

Two caveats:

- **Check the model still fits.** A larger window means a larger KV cache. Past
  what VRAM allows, Ollama silently offloads layers to CPU and the model becomes
  unusably slow rather than failing loudly. Raise it a step at a time.
- **A background service can't inherit the setting.** A launchd/systemd-managed
  `ollama serve` runs from its own unit file, so when a window is configured
  PortOS starts (or restarts) Ollama itself.

The Models → Runtimes page shows the window loaded models are actually running
at, and flags it when it's below what an agent harness needs.

### Ollama API provider ignores its num_ctx (prompts truncated to ~2K tokens)

**Symptom**: a local mind or CoS run on the `ollama` API provider behaves as if
it forgot most of its prompt; the Ollama log repeats
`truncating input prompt limit=2050 prompt=14776` and `ollama ps` shows the
model at `CONTEXT 4096` even though **Local num_ctx** is set higher.

**Cause**: Ollama's OpenAI-compatible `/v1/chat/completions` has no way to set
the context window — it ignores `num_ctx` in any position — so each `/v1`
request loads the model at the daemon default.

**Solution**: update PortOS. An API run whose Ollama provider sets **Local
num_ctx** is sent to Ollama's native `/api/chat` with `options.num_ctx`, which
loads the model at that window. Runs with no num_ctx stay on `/v1` and use the
daemon default (`OLLAMA_CONTEXT_LENGTH`).

## Chief of Staff Issues

### CoS Not Running

**Symptom**: CoS page shows "Stopped" status.

**Solution**:
1. Click "Start" button in CoS UI
2. Or enable `alwaysOn: true` in CoS config
3. Check server logs for startup errors

### Agents Not Spawning

**Symptom**: Tasks stay in "pending" status, no agents start.

**Solution**:
```bash
# Check CoS runner is running
npm run pm2:status | grep portos-cos

# Check runner logs
npm run pm2:logs -- portos-cos --lines 100

# Verify Claude CLI is available
which claude
```

### Every Agent Spawn Fails with `posix_spawn failed: No such file or directory`

**Cause**: `npm ci` or `npm install` was run inside a CoS worktree
(`data/cos/worktrees/*`). A fresh `git worktree` has no `node_modules`, so agents
symlink the primary checkout's `node_modules`, `client/node_modules` and
`server/node_modules` into the worktree to make `vitest` runnable. npm does not
treat that symlink as a boundary: it empties the **target** — the primary
checkout's real `node_modules` — then replaces the symlink with a fresh real
directory in the worktree and installs there. The primary is left with an EMPTY
`node_modules`, and removing the worktree does nothing to restore it.

This takes the whole CoS fleet down at once: `portos-cos` keeps running on its
already-loaded node-pty binding, but node-pty execs its `spawn-helper` binary
from disk on EVERY spawn, so every agent spawn fails with the opaque error above
until someone reinstalls. The runner names this fault instead of retrying it —
see `server/lib/ptySpawnDiagnostics.js`.

**Recovery**:
```bash
# In the PRIMARY checkout, never in a worktree
npm install --prefix server
npm install --prefix client
npx pm2 restart portos-cos
```

**Prevention**: ordinary CoS worktrees share dependencies through symlinks, so
use the workspace binaries from the primary checkout
(`server/node_modules/.bin/vitest run <files>`) and never install there. The
`dependency-updates` scheduled task is the exception: its managed worktree gets
no dependency symlinks, and any package-manager install stays in that worktree.

### Worktree Tests Fail on a Clean Tree in a Workspace-Link Repo (Stale Workspace Packages)

**Symptom**: In a managed repo that uses npm workspaces (`node_modules/@scope/pkg
-> ../../packages/pkg`), a fresh CoS or claim worktree fails tests that import a
workspace package — a `TypeError` on a field the branch just added, or a path
assertion naming the primary checkout — even though the branch is untouched.

**Cause**: a plain `worktree/node_modules -> primary/node_modules` symlink
resolves the workspace links against the PRIMARY checkout. When the primary's
checked-out branch is behind the worktree's base, `require('@scope/pkg')` loads
the primary's stale `packages/pkg`. The branch is fine; the environment is not.

**Fix**: `scripts/link-worktree-deps.js` (and `worktreeManager`'s dependency
linking) now detects workspace links in the source's `node_modules` and builds a
REAL `node_modules` directory in the worktree. Every entry is symlinked to the
primary except the workspace links, which are recreated with the same relative
targets so they resolve inside the worktree. Provisioning refuses a link that
would resolve outside the worktree (`server/lib/worktreeNodeModules.js`). The
directory carries a `.portos-worktree-links` marker so cleanup removes only what
it created.

**Existing worktrees** keep whatever they were given (provisioning never replaces
an existing path). To repair one, delete the `node_modules` symlink in the
worktree and rerun `node scripts/link-worktree-deps.js <primary> <worktree>`.
Still never run `npm install` in a worktree.

### Tasks Not Being Picked Up

**Symptom**: Added a task but CoS ignores it.

**Solution**:
1. Add tasks through the UI or `POST /api/cos/tasks`; the queues are database rows (`cos_tasks`), and editing `data/TASKS.md` no longer does anything. After an update the old files are kept as `data/*.md.imported`.
2. Check the task's status and approval flag in the Tasks tab (a task awaiting approval does not run).
3. Trigger manual evaluation via UI

### Agent Writes Files Into the PortOS Folder Instead of My App

**Symptom**: You pick an app as the workspace (in a CoS task, or **Settings → Providers → Run Prompt**) and ask the agent to create a file. It lands in the PortOS directory instead of the app's repo. Giving the agent an **absolute** path in the prompt works fine.

**Cause**: There were two, and they look identical from the outside.

1. **A workspace that didn't resolve.** The agent's working directory comes from the selected app's **Repository Path** (`repoPath`) — nothing else. If that value was empty, pointed at a folder that no longer exists, or the app couldn't be resolved, older versions of PortOS fell back to their own directory without saying so, and a prompt naming a relative file (`HelloWorld.md`) wrote there.
2. **A CLI that ignored the working directory it was given.** Starting a process with a working directory does not update `PWD` in the environment it inherits, and **OpenCode** reads `PWD` in preference to its real working directory. So OpenCode agents ran in the PortOS folder no matter which app was selected — the spawn logs reported the app's repo correctly, and asking the agent to print its own working directory printed the PortOS path. Codex, Claude Code, and Gemini were unaffected, which made it look like an OpenCode-only quirk. PortOS now pins `PWD` to the real working directory at every spawn, so OpenCode lands in the same place as everything else.

**`PORTOS_WORKSPACE_ROOTS` does not control this.** That variable only scopes which directories the repo-detection and command-execution routes are allowed to read. Setting it will not change where an agent runs, and it is not required for agent workspaces to work.

**Solution**:
1. Open **Apps**, edit the app, and confirm **Repository Path** is the path to the repo — e.g. `C:\Users\Example\Projects\MyApp` on Windows, `/Users/example/Projects/MyApp` on macOS/Linux. A path with a typo, a trailing quote, or a since-moved folder is the usual culprit.
2. Re-run and read the working directory PortOS now reports for every run:
   ```
   📂 Run <run-id> cwd: C:\Users\Example\Projects\MyApp
   ```
   CoS tasks show the same line in the task log as `📂 Agent workspace: …`.
3. If that logged path is already your app's repo but files still land in the PortOS folder, you're hitting cause 2 above — **update PortOS**. Until you do, the workaround is to give the agent absolute paths in the prompt, or to run the task on a different provider (Codex, Claude Code, and Gemini were never affected).

PortOS no longer falls back silently, so a misconfigured app now surfaces as one of these instead of a wrong-directory write:

| What you see | What it means |
|---|---|
| `❌ Workspace path does not exist: <path>` (run fails immediately) | The Repository Path points somewhere that isn't there. Fix it in Apps and re-run. |
| `❌ Workspace path is not a directory: <path>` | The Repository Path points at a file. Set it to the repo folder. |
| `❌ App '<id>' didn't resolve to a repository directory` (CoS task is **blocked**, no agent starts) | The app record has an empty Repository Path, or nothing in Apps matches that id/name at all. Set the path in Apps — or clear the app from the task if it doesn't belong to one — then re-run it. The task stays in **Blocked** until you do. |

**Note for Windows**: use a real filesystem path with a drive letter (`C:\...`). Both `C:\Users\...` and `C:/Users/...` work, as does a leading `~`; a path inside OneDrive-redirected folders is fine as long as it exists locally.

### "path is outside allowed directories" for a Repo on a Secondary Drive

**Symptom**: Opening an app's **Submodules** tab (or another view that sends a repo path to the server) fails, and the server log shows:

```
❌ Route error [GET /api/git/submodules/status]: path is outside allowed directories
```

**Cause**: Routes that accept a caller-supplied filesystem path confine it to a set of allowed roots. Those defaults were POSIX-only (`/tmp`, `/Users`, `/Volumes`, `/opt`) — on Windows they resolve to whatever drive the process happens to be running from, so a repo on a second drive (`D:\code\myapp`) matched nothing, and on Linux a repo under `/mnt` or `/media` matched nothing either. Either way the request was rejected with a 403.

**Solution**: Update PortOS. The defaults now cover wherever each platform mounts secondary volumes: `/Volumes` on macOS, `/mnt` and `/media` on Linux, and on Windows your home directory, the temp directory, and any lettered drive that isn't the system drive. The rest of the Windows system drive stays off-limits (`C:\Windows`, `C:\Program Files`), as do UNC paths (`\\server\share`) — map the share to a drive letter if you keep repos on it.

For anywhere else, set `PORTOS_WORKSPACE_ROOTS`. Separate entries with `;` on Windows (`D:\repos;E:\projects`) — a colon would split the value at the drive letter. macOS/Linux still use `:` (`/srv/git:/data/projects`).

### Memory System Not Working

**Symptom**: Memory search returns no results, embeddings fail.

**Solution**:
1. Ensure LM Studio is running on port 1234
2. Load an embedding model in LM Studio (e.g., `nomic-embed-text`)
3. Check memory embeddings status: `GET /api/memory/embeddings/status`

## PM2 Issues

All PM2 commands below use the bundled copy at `node ./node_modules/pm2/bin/pm2`, accessed through npm scripts (`npm run pm2:*`) or `npx pm2 …`. A globally installed `pm2` works too, but these forms need nothing beyond `npm run setup`.

### Process Keeps Restarting

**Symptom**: PM2 shows high restart count, app unstable.

**Solution**:
```bash
# Check for crash reason
npm run pm2:logs -- portos-server --lines 200

# Common causes:
# - Unhandled exceptions (check error handling)
# - Memory limit exceeded (increase max_memory_restart)
# - Missing environment variables
```

### Cannot Stop Processes

**Symptom**: `npm run pm2:stop` doesn't work or processes restart.

**Solution**:
```bash
# Stop specific ecosystem (scoped to PortOS's apps)
npm run pm2:stop

# Never use these (affects all PM2 apps):
# npx pm2 kill        ← Don't use
# npx pm2 delete all  ← Don't use
```

### Old Code Running After Changes

**Symptom**: Code changes don't take effect.

**Solution**:
```bash
# Development: restart all dev apps, including Vite on :5554
npm run dev

# Production: rebuild the client and restart production apps
npm start
```

## Database/Data Issues

### Server Won't Boot: Database Unreachable

**Symptom**: Server fails fast at startup with a database health error.

PostgreSQL is a **mandatory** dependency (see [STORAGE.md](./STORAGE.md)) — there is no silent file fallback.

**Solution**:
```bash
# Re-run DB provisioning (system pg on :5432 or Docker on :5561)
npm run setup:db

# Docker mode: make sure the container is up
docker compose up -d

# Check what's answering
pg_isready -h localhost -p 5432 || pg_isready -h localhost -p 5561
```

### Missing/Corrupted Relational Data

Universes, series, catalog ingredients, memories, and other relational records live in PostgreSQL, not `data/` files. Inspect them via the Database settings tab or `psql`. To recover, restore a snapshot's `portos-db.sql` from the Backup tab (see [BACKUP.md](./BACKUP.md)).

### Legacy Record Split Stamped Applied With a Corrupt Source

**Symptom**: On an install that upgraded before #9557, `data/universe-builder.json` (migration 034), `data/pipeline-issues.json` (035) or `data/pipeline-series.json` (036) was truncated when migrations ran. The migration was stamped applied in `data/migrations.applied.json`, but `data/universes/`, `data/pipeline-issues/` or `data/pipeline-series/` lacks the records. Current builds throw and keep the migration pending instead, so only already-stamped installs need this.

**Solution** (touch only the affected split):
```bash
# 1. Stop PortOS, then back up the source, the target layout and the ledger.
#    npm run pm2:stop stops only PortOS's apps — never `pm2 stop all`, which also
#    stops every other app on the shared PM2 daemon.
npm run pm2:stop
cp -R data/pipeline-issues data/pipeline-issues.bak-manual 2>/dev/null
mkdir -p data/manual-backup && cp data/pipeline-issues.json* data/manual-backup/ 2>/dev/null
cp data/migrations.applied.json data/migrations.applied.json.bak-manual

# 2. Repair the source JSON (restore from a backup or fix the truncation).
#    If the migration already renamed it, repair the `.bak-035` file instead.

# 3. Remove ONLY the affected migration's entry (e.g. 035-split-pipeline-issues-to-per-id.js)
#    from data/migrations.applied.json — never clear the whole list.

# 4. Re-run migrations; records already split are kept, only missing ones are added
node scripts/run-migrations.js
npm run pm2:start
```

The split never overwrites a record directory that already exists. If a later Postgres import (`server/scripts/migrateUniversesToDB.js` and similar) already ran, re-run that explicit legacy-import tool after the split rather than resetting import markers or schema versions.

### Collection images or pinned covers lost after migration 428

Migration 428 inferred deletion from missing local image bytes. That is invalid for peer-hosted media, whose bytes intentionally remain on the hosting peer, and for temporarily unavailable files. The migration runner now records pending `428-prune-dangling-collection-images.js` without executing its frozen transform, including when the ledger is missing or rebuilt. This policy is persisted before any other pending migration runs, so an interrupted upgrade cannot re-arm it. Explicit gallery deletion still removes the references for the image being deleted.

If 428 already ran, preserve the current collection and recover membership from an unaffected peer or retained backup. Union synchronization may re-add the image items, but the migration also stamped a newer null `coverKey`; scalar last-write-wins synchronization cannot automatically restore that pinned cover. Select the intended cover explicitly after recovery. The peer-hosted media index does not record collection ownership and cannot reconstruct memberships. Do not rerun absence-based cleanup or overwrite newer edits with reconstructed guesses.

### "Another migration run holds data/migrations.lock"

**Symptom**: `npm run migrations` or server boot exits with `Another migration run (pid N) holds …/data/migrations.lock`.

Only one migration runner may touch `data/migrations.applied.json` at a time: the booting server and a manual `npm run migrations` would otherwise both read the ledger before either persists it and apply the same migration twice. The second runner waits up to a minute for the holder to finish, then gives up with this message. Let the running server finish booting (or stop it with `pm2 stop portos`) and retry. A live holder never expires, even during a long upgrade. A runner that died mid-run (power loss, `kill -9`) leaves the directory behind; the next run reclaims it once the recorded pid is gone. An acquisition with a missing or malformed owner can be reclaimed after 30 minutes; other owner-read errors refuse recovery.

Release and stale recovery serialize through `data/migrations.lock/.transition`. If a process dies during that brief transition, the lock stays closed rather than risking duplicate migrations. Stop all migration runners before removing `data/migrations.lock` by hand, then retry. A crash after atomic retirement can also leave a `data/migrations.lock.retired-*` directory; it is no longer an active lock and can be removed once runners have stopped.

### Lost App Registrations

**Symptom**: Apps disappear after restart.

**Causes**:
- `data/apps.json` was deleted or corrupted (app registry is file-backed)
- File permissions prevent writing

**Solution**:
```bash
# Check file exists and is valid JSON
cat data/apps.json | jq .

# If corrupted, restore from backup or recreate
```

### History Not Persisting

**Symptom**: Action history clears on restart.

**Solution**:
- Check `data/history.jsonl` exists and is writable
- Verify disk space available

## Performance Issues

### Slow UI Loading

**Causes and Solutions**:
1. **Large log files**: Clear PortOS logs with `npx pm2 flush portos-server` (or `npx pm2 flush portos-cos`, etc.). Never use bare `npx pm2 flush`, which also clears every other app's logs.
2. **Many apps**: Pagination added in recent versions
3. **Network latency**: Use local access when possible

### Agents Page Stalls (Slow CoS State Operations)

**Symptom**: the Agents page is slow or unavailable while PM2 reads time out or peer probes fail around the same time.

CoS runtime records share one serialized state queue (`withStateLock` in `server/services/cosState.js`). Slow operations on it log bounded numbers only: no records, tokens, paths, hostnames or task text.

| Line | When |
|------|------|
| `❌ PM2 read failed (home=…): pm2 RPC timed out; … wallMs=… cpuMs=… load1=… cpus=… gcMs=… invCtx=…` | the first timed-out PM2 process-list read of a failure streak |
| `🐢 CoS state write slow outcome=… totalMs=… prepareMs agentsMs serializeMs writeMs replaceMs dirSyncMs loopLagMs loopLagMaxMs sizeKiB` | any `saveState` of 1 s or more |
| `🐢 CoS state queue slow hold heldMs=… waitMs=… loopLagMs=… loopLagMaxMs=…` | any operation that held the queue for 1 s or more |

Elapsed time inside an awaited phase is asynchronous wait plus delayed scheduling. While an instrumented operation is open, a 100 ms tick measures how long timers sat overdue (`server/lib/eventLoopLagProbe.js`) and charges that to the current phase as `…LagMs`. Read each slow phase as lag versus the rest:

- **Queue hold high (`🐢 CoS state queue slow hold`, `heldMs`/`waitMs`), `loopLagMs` near 0** — other operations held the state queue while the loop stayed responsive.
- **Write phases high (`🐢 CoS state write slow`), `…LagMs` near 0** — asynchronous I/O wait: storage or fsync latency, or libuv threadpool queueing behind other file work. `agentsMs` (the changed `cos_agents` rows, written in one transaction), `writeMs` (temp write + file flush), `replaceMs` (rename) and `dirSyncMs` (directory flush) locate it.
- **`loopLagMs` close to the phase time** — the event loop could not run: blocking JavaScript, garbage collection, host CPU starvation or process suspension. The attribution fields below tell those apart.

**Lag attribution (#12852).** When an operation is charged more than 1,000 ms of loop lag, its line ends with `cpuMs=… load1=… cpus=… gcMs=… invCtx=…` measured over the same span. The PM2 timeout line carries them over the read, with `wallMs` as its span. Compare `cpuMs` with the span's wall time (`totalMs`, `heldMs` or `wallMs`):

| Reading | Bucket | Next step |
|---------|--------|-----------|
| `cpuMs` near the wall time, `gcMs` a small share of it | **busy process**: blocking JavaScript | take one CPU profile on the next stall through the [safe inspector path](#dynamic-import-callback-missing-after-profiling); move the hot synchronous work off the loop, or chunk it |
| `gcMs` a large share of `cpuMs` | **garbage collection** | reduce the allocation the profile names; a large `sizeKiB` on the state write points at snapshot cloning first |
| `cpuMs` well below the wall time, `load1` at or above `cpus`, `invCtx` high | **host starvation**: other processes held the CPUs | reduce concurrent heavy work on the host (agent validation, full test suites), not PortOS code |
| `cpuMs` and `load1` both low | **suspension**: the process was not scheduled at all (host sleep, a debugger, a stopped process) | check host power and debugger state for that window |

`cpuMs` is this process's user plus system time, so worker threads can push it above the wall time. `load1` is the host's one-minute load average and trails a sudden spike. `gcMs` counts collections by when they started, and one finishing in a span's last loop turn may be missed. A span charged 1,000 ms of lag or less prints none of these fields.

Lag resolves to about one tick: the first 100 ms of a stall and any overdue stretch of 20 ms or less are not counted.

**Baseline.** In an isolated synthetic run (a temp directory, a ~1 MiB state-shaped document, real `atomicWrite`, no induced load), a full state write took 14 ms median and 35 ms worst over 20 runs (serialize ~2 ms, write ≤ 20 ms, directory flush ≤ 8 ms) with no measurable lag, and parsing took ~1–2 ms. Multi-second phases are therefore not explained by the size of the document.

**Status of #12329.** The incident that motivated these lines (a 35.9 s persistence phase, and a deadline that fired 9.4 s late) predates them. Whether its persistence time was storage latency or scheduling pressure is **unresolved**; the overdue deadline established scheduling delay only for the queue wait. Choose a latency fix only after a safely observed incident shows which bucket dominates, and record before/after numbers at that boundary. Do not induce overload on a live install, or run concurrent heavy suites, to obtain them.

**Log timestamps.** `LOG_DATE_FORMAT` in `ecosystem.config.cjs` already emits a real UTC offset (#11436). A PM2 process registered before that change keeps its old format, which labels local wall-clock time with a literal `Z`, until it is restarted from the ecosystem file as part of a normal, authorized rollout. Until then, correlate log lines by comparing a fresh line with its file modification time or the health endpoint's timestamp rather than trusting the suffix.

### High Memory Usage

**Solution**:
```bash
# Check PM2 memory usage
npx pm2 monit

# Set memory limits in ecosystem.config.cjs
max_memory_restart: '500M'
```

### Agent Runs Timeout

**Symptom**: AI runs hit timeout before completing.

**Solution**:
- Increase timeout in provider settings
- Break large tasks into smaller chunks
- Check network connectivity to AI provider

## Development Issues

### A merged checkout disappeared without an archive receipt

`retirement-provenance-unverified` means a previously inventoried checkout or
local ref is missing and its removal has not been established. It is an
unresolved obligation, not successful cleanup. The retirement API refuses this
case, and the Schedule view retains the exact observed branch, path and head
through later empty scans. A surviving branch, merged PR or integrated commit
does not by itself prove the checkout was retired on purpose.

Trace the deletion actor and command separately from the PR's merge actor.
Current retirement does not copy the checkout. Older directories
`data/cos/held-checkout-archives/` and `data/cos/branch-retirement-archives/`
remain available after setup; migration 442 preserves historical recovery data.
A new retirement will not leave a manifest there. Existing copies may be the
only recovery source and must not be deleted merely because new copies are no
longer written. Do not reconstruct a partial checkout as proof, delete another
checkout, or clear the obligation merely because the source is gone. If
provenance cannot be recovered, retain the evidence and missing source identity
in the owning issue; #13271 records such an unresolved case without attributing
its local deletion to the merge actor.

### "Another git process seems to be running" — but none is

**Symptom**: every git command against one repo (or, most often, every submodule
checkout) fails with:

```
fatal: Unable to create '<repo>/.git/modules/lib/slashdo/index.lock': File exists.
Another git process seems to be running in this repository, or the lock file may be stale
fatal: Unable to checkout '<sha>' in submodule path 'lib/slashdo'
```

**Cause**: a git process was killed before it could remove its lock file — a PM2
tree-kill during self-update, an `execGit` timeout, a reaped CoS agent. The lock
outlives the process and nothing else removes it, so the failure is permanent.
A submodule lock lives in `.git/modules/<submodule>/`, which every git worktree
of the repo shares, so ONE dead process wedges submodule checkout for the primary
checkout, every CoS agent worktree, `update.sh` and `npm run setup` at once.

**PortOS clears this itself** on the paths that hit it — the Submodules tab's
Update button and CoS worktree creation both remove a lock older than 30 minutes
and retry, `update.sh` / `update.ps1` sweep one before they start (they are the
likeliest producer), and `npm run doctor` names the lock as the blocker instead
of telling you to run the command that will fail. One rule, in
`server/lib/gitStaleLock.js`: a lock young enough to still belong to a running
git command is never touched.

**Manual recovery** (confirm no git process is really running first):

```bash
ps aux | grep '[g]it'                  # must show nothing working on this repo
find .git -name '*.lock' -not -path '*/rr-cache/*'
rm <the-lock-path>
git submodule update --init --recursive
```

### Hot Reload Not Working

**Symptom**: Frontend changes require manual refresh.

**Solution**:
- Check Vite is running: `npm run pm2:logs -- portos-ui`
- Ensure file watchers aren't exhausted: `fs.inotify.max_user_watches`

### Tests Failing

**Solution**:
```bash
cd server
npm test

# For specific test file
npm test -- lib/taskParser.test.js

# Watch mode for development
npm run test:watch
```

### CI red with every job "cancelled"

A failing job no longer cancels its siblings, so a real test failure shows as a
job that concluded `failure`. Open it and read the assertion, or use
`gh run view --log-failed`. To rerun only that shard, use **Re-run failed jobs**.

A run where every job reads `cancelled` has one of three causes:

1. **A newer push superseded it.** `cancel-in-progress` is per PR, and a
   supersession always leaves a newer run for the same branch:

   ```bash
   gh run list --branch "<head-branch>" --workflow CI \
     --json databaseId,headSha,status,conclusion,createdAt,attempt
   ```

2. **A job hit its own `timeout-minutes`.** GitHub records that as `cancelled`,
   not `timed_out`. The job carries an annotation reading "exceeded the maximum
   execution time", and the step that was running is the slow one (a stalled
   package download, a hang). A cancelled job keeps its steps' conclusions, so
   the `CI Gate` summary (`scripts/ci-gate-report.js`) names any step that
   failed before the cancel. By hand:

   ```bash
   gh api "/repos/atomantic/PortOS/actions/runs/<run-id>/jobs?per_page=100" \
     --jq '.jobs[] | select(any(.steps[]?; .conclusion=="failure")) | .name'
   ```

3. **An external cancel**, such as GitHub cancelling in-flight runs under load,
   the Actions spending limit, or someone pressing cancel. There is no newer
   run and no failed step. Only the account owner can check or raise the
   spending limit (`gh auth refresh -s user`, then
   `gh api /users/<your-login>/settings/billing/actions`).

**What PortOS does about it.** `.github/workflows/ci-cancel-recovery.yml`
re-dispatches a cancelled pull-request run exactly once when no job failed, no
job hit its timeout, and no newer run exists for the branch. Its summary page
says which of those applied. A run you cancel by hand looks like an external
cancel and gets the same single retry; push a new commit or close the PR if you
want it to stay stopped.

### Windows server unit tests fail but macOS/Linux pass

**Symptom**: `Windows server unit tests (n/3)` is the only shard with a real
assertion failure.

The cause is almost always a **test** that hardcodes the POSIX answer to a
platform-dependent question, not a production bug. Three recurring shapes:

- **Shell quoting.** `formatShellCommandLine` (`server/lib/shellCd.js`) quotes
  for the session's shell, so a line that reads `pi --provider nvidia` under
  `zsh` reads `& 'pi' '--provider' 'nvidia'` under PowerShell. Assert on the
  flags, not the dialect — strip the quoting first, the way
  `server/services/compositeProviders.test.js` and
  `server/lib/tuiShellLaunch.test.js` do. Reproduce locally with
  `PORTOS_SHELL=pwsh`, which yields the exact Windows string with no runner:

  ```bash
  cd server && PORTOS_SHELL=pwsh node_modules/.bin/vitest run <suite>
  ```

- **Path separators.** A suite that mocks `node:os` `platform()` still gets the
  host's `path.join`, so POSIX-style fixtures diverge from the `C:\…` the module
  builds. Simulate it by mocking `node:path` to `path.win32` in a throwaway copy
  of the suite, and prefer `dirname`/`join` over separator regexes in the code
  under test.

- **Platform-gated behaviour flags.** When production deliberately decides
  something per platform (`needsProcessGroup(...)` returning `false` on Windows
  because `taskkill /T` already covers the tree), assert the *policy* in the
  helper's own unit test with an injected platform, and derive the call-site
  expectation from `process.platform` rather than writing the POSIX literal.
  An assertion with no Windows meaning at all belongs behind
  `it.skipIf(process.platform === 'win32')`.

## Known Issues

### GPU watchdog kernel panic during LoRA training

**Symptom**: The whole machine hard-reboots while an mflux LoRA training run is
active. After reboot you may see downstream PortOS errors — training failed with
`SIGINT`/`KeyboardInterrupt`, `Tombstone sweep failed: timeout … connect`, CoS
`xhr poll error`. The crash report under `/Library/Logs/DiagnosticReports/` reads:

```
panic(cpu N caller 0x…): watchdog timeout: no checkins from watchdogd in 90 seconds
```

**Cause**: A system-level hang (not a PortOS or training-script bug) — the machine
stopped making forward progress long enough that the hardware watchdog
force-rebooted it. On new Apple Silicon (M5 / `Mac17,7`) under sustained Metal/GPU
load this is most likely a GPU/Metal driver hang; thermal/power or severe swap
thrash are secondary possibilities. First observed 2026-06-13 (twice in one day).

**Upstream root cause (mlx #3267 / #3186)**: This is an Apple Metal/IOGPU driver
behavior, confirmed across M2/M3/M4/M5 hardware, not a PortOS bug. Two related
forms: the GPU watchdog kills a training process whose command buffers compete
with **active-display WindowServer compositing**
([mlx #3267](https://github.com/ml-explore/mlx/issues/3267),
`kIOGPUCommandBufferCallbackErrorImpactingInteractivity`), escalating on M5-class
silicon to the full `watchdogd` kernel panic above; and a separate IOGPU
memory-management panic ([mlx #3186](https://github.com/ml-explore/mlx/issues/3186),
filed with Apple as FB22091885). The MLX maintainer's confirmed workaround is the
`AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1` env var — **PortOS now sets this automatically**
for the trainer and FastVideo MLX runner (`scripts/train_mflux_lora.py`,
`scripts/generate_fastvideo.py`). Note per #3267 the kill is at the
IOGPU layer *above* the process boundary, so process-teardown segmentation alone
does not prevent it; the env var attacks the actual cause.

**Strongest user-side mitigation — keep the display off the GPU.** The watchdog
fires hardest when training competes with the active display. Run training with the
display asleep / lid closed under `caffeinate -s &`, or drive the box headless over
SSH from another machine. With no WindowServer compositing the watchdog has nothing
to protect and largely stops firing.

> **Validated on M5 Max (2026-06-27) — keeping the display off is what works.**
> A clean A/B on the *same* 9B-bf16 segmentation-OFF config, both with
> `AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1` set:
> - **Display active** → hard-rebooted within minutes (at step 0). Telemetry: Nominal
>   thermal pressure (a GPU **driver hang**, not heat); paniclog top-CPU thread was
>   `WindowServer` (active-display contention).
> - **Display asleep** (`pmset displaysleepnow`, lid open) → **reached step 302**,
>   clearing the documented 150–300 panic window with no panic.
>
> So for a **9B / heavy bf16 run, the env var is necessary but not sufficient — you
> must also keep the display off**: drive the box over SSH (cleanest), or run
> `pmset displaysleepnow` right after launching. `caffeinate -s` alone does *not*
> turn the display off; it only prevents system sleep, and **closing the lid sleeps
> the whole machine** (suspending the run) unless an external display is attached.
> Also prefer **segmentation ON** (the shipped default), which completed a full 4B
> run cleanly on this box.

**Mitigations already in place**:
- `AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1` is set automatically by the trainer (the
  maintainer-confirmed workaround for mlx #3267); the run log shows
  `STATUS:watchdog mitigation · AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1` so a paniclog
  records whether it was active. Set it to `0` in the environment to disable.
- Video Gen sleeps the display automatically for local MLX runtimes (FastVideo,
  Wan 2.2, MiniMax H3, and LTX) while keeping the system awake. This is on by
  default; disable **Sleep display during local MLX video renders** in Settings
  > Image Gen > Defaults only when another headless workflow manages it.
- The mlx/mlx-metal backend is pinned to the validated 0.31.2 trio in
  `scripts/setup-image-video.sh` (the original panics were on 0.30.6).
- Training checkpoints at least every `ceil(totalSteps/4)` steps
  (`MFLUX_MIN_CHECKPOINTS`), so a crash loses at most ~¼ of a run. Resume from the
  newest `checkpoints/*.zip` via the UI's resume action or `--resume-checkpoint`.
- Each run captures GPU/thermal/power telemetry to `<run>/powermetrics.log` (a
  resume rolls to a timestamped `powermetrics.<ts>.log` so the pre-crash log is
  preserved) when passwordless `powermetrics` is configured (see the incident
  record for the sudoers rule).
- Memory pressure is bounded before each run (`memoryPrep.js`): resident Ollama /
  LM Studio models on loopback-local backends are unloaded to free unified memory
  (a remote LAN backend is left untouched), the encoded-dataset cache
  always spills to disk (`low_ram`), the quantize tier is sized to *available*
  memory rather than total RAM, and a run refuses to start when under ~24 GB is
  free — so an oversubscribed run can't swap-thrash the box into a reboot. If a
  run won't start with a "not enough free memory" error, stop other model servers
  or close apps and retry.
- The frozen base is **never auto-trained as unquantized bf16** (issue #1321):
  the top tier is now 8-bit QLoRA even on a ≥96 GB box. Auto-bf16-9B was both
  pathologically slow and the exact config that panicked this machine three
  times, so it's opt-in only — a run that genuinely wants it sets **Base quant →
  16** in the training panel (or `LORA_TRAIN_MAX_QUANT_BITS=8`/`=4` still forces
  an even lighter ceiling install-wide).

**What to do / how to investigate**: see the full incident record and checklist in
[`docs/research/2026-06-13-mflux-training-watchdog-panic.md`](research/2026-06-13-mflux-training-watchdog-panic.md).
Short version: read the run's newest `powermetrics*.log` (climbing GPU temp → cooling/power;
log just stops at normal temps → driver hang), reduce batch size/resolution/rank as
a test, and update macOS + `mflux`/`mlx`.

## Getting Help

1. **Check logs**: `npm run pm2:logs` shows all PortOS process output
2. **Browser console**: F12 → Console for frontend errors
3. **Server logs**: Look for emoji prefixes (❌ errors, ⚠️ warnings)
4. **GitHub Issues**: Report bugs at https://github.com/atomantic/PortOS/issues

## Recovering a store with an orphaned `.bak` file

**Symptom**: a read reports a store as unreadable with "is missing but a `<name>.*.bak` backup sibling exists — recovery required", or a Windows write fails with "stayed locked … the existing file was left untouched".

**Cause**: Windows can keep a file locked (antivirus scan, open handle) so the atomic replace is refused. Current versions retry briefly, then fail the write and leave the original file untouched. Older versions instead moved the file to `<name>.<pid>.<ts>.<uuid>.bak` and could lose the canonical copy if installing the new file also failed. PortOS never picks a backup automatically, because it cannot tell which copy is correct.

**Solution**:

1. Stop PortOS (and anything else that writes the data directory) so nothing recreates the canonical file.
2. Keep every copy — do not delete any `.bak` or `.tmp` sibling yet.
3. Inspect the `.bak` files (newest timestamp first) and decide which holds the right state.
4. Copy the chosen one to the canonical filename (e.g. `settings.json`), leaving the other copies in place.
5. Restart PortOS, confirm the data is intact, then remove the leftover backups.

For a failed write, wait for the lock to clear (pause the antivirus scan on the data directory) and repeat the action; no recovery is needed.
