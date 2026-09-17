# Troubleshooting Guide

Common issues and solutions when running PortOS.

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
running install legitimately occupies ports 5553–5561.

Details name no hostnames, usernames, IPs, or home-directory paths, so the
output is safe to paste into a bug report as-is.


### Port Already in Use

**Symptom**: Server fails to start with `EADDRINUSE` error.

**Solution**:
```bash
# Find what's using the port
lsof -i :5554
lsof -i :5555

# Kill the process or choose different ports in ecosystem.config.cjs
```

### PM2 Process Not Starting

**Symptom**: `pm2 start ecosystem.config.cjs` shows process but status is `errored`.

**Solution**:
```bash
# Check PM2 logs for errors
pm2 logs portos-server --lines 100

# Common causes:
# - Missing dependencies: npm run install:all
# - Missing data directory: mkdir -p data
# - Port conflict: check EADDRINUSE errors
```

### Missing Data Directory

**Symptom**: Server crashes with `ENOENT` errors about files in `data/`.

**Solution**:
```bash
# Copy sample data files
cp -r data.reference/* data/
```

## Connection Issues

### Cannot Access from Other Devices

**Symptom**: PortOS works on localhost but not from phone/tablet.

**Causes and Solutions**:

1. **Tailscale not connected**: Ensure both devices are on same Tailscale network
2. **Firewall blocking**: Check local firewall allows ports 5554-5555
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
- Verify server is running: `pm2 status`
- Restart server: `pm2 restart ecosystem.config.cjs`

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
pm2 status | grep portos-cos

# Check runner logs
pm2 logs portos-cos --lines 100

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
pm2 restart portos-cos
```

**Prevention**: if a worktree is missing dependencies, symlink them from the
primary checkout and call the workspace binaries directly
(`server/node_modules/.bin/vitest run <files>`) — never install.

### Tasks Not Being Picked Up

**Symptom**: Added tasks to TASKS.md but CoS ignores them.

**Solution**:
1. Verify task format matches expected syntax:
   ```markdown
   ## Pending
   - [ ] #task-001 | HIGH | Task description
   ```
2. Check file path in CoS config matches your TASKS.md location
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

### Process Keeps Restarting

**Symptom**: PM2 shows high restart count, app unstable.

**Solution**:
```bash
# Check for crash reason
pm2 logs portos-server --lines 200

# Common causes:
# - Unhandled exceptions (check error handling)
# - Memory limit exceeded (increase max_memory_restart)
# - Missing environment variables
```

### Cannot Stop Processes

**Symptom**: `pm2 stop` doesn't work or processes restart.

**Solution**:
```bash
# Stop specific ecosystem
pm2 stop ecosystem.config.cjs

# Never use these (affects all PM2 apps):
# pm2 kill        ← Don't use
# pm2 delete all  ← Don't use
```

### Old Code Running After Changes

**Symptom**: Code changes don't take effect.

**Solution**:
```bash
# Restart to pick up changes
pm2 restart ecosystem.config.cjs

# For frontend changes, Vite hot-reload should work
# For server changes, PM2 watch mode can help (if enabled)
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
1. **Large log files**: Clear old logs with `pm2 flush`
2. **Many apps**: Pagination added in recent versions
3. **Network latency**: Use local access when possible

### High Memory Usage

**Solution**:
```bash
# Check PM2 memory usage
pm2 monit

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
- Check Vite is running: `pm2 logs portos-ui`
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

### CI cancelled with no successor run

**Symptom**: A pull request's `CI Gate` / `Full CI Gate` goes red while several
PRs are building at once. Opening the run shows no failing assertion — jobs
report `##[error]The operation was canceled.` mid-step, often inside
`actions/checkout`, and the in-workflow `Cancel sibling CI jobs after failure`
step is `skipped` in every job. Re-running is usually cancelled the same way
until the queue empties; the identical SHA then passes on an idle queue.

**What it is not**: this is *not* `cancel-in-progress` doing its job. The
concurrency group is per-PR (`.github/workflows/ci.yml`), and a legitimate
supersession always leaves a **newer run** for the same PR. An external cancel
leaves none.

**The likely cause is the Actions spending limit, not the concurrent-job cap.**
Exceeding the job cap makes GitHub *queue* runs; cancelling in-flight runs is
the spending-limit behaviour. So the billing reading below is the primary
diagnostic, not a footnote. Full runs are expensive because the three Windows
shards bill at a 2× minute multiplier.

**Tell the two apart** — list the runs for the branch and look for a successor:

```bash
# Every run for one PR branch, newest first. A supersession has a run NEWER
# than the cancelled one; an external cancel does not.
gh run list --branch "<head-branch>" --workflow CI \
  --json databaseId,headSha,status,conclusion,createdAt,attempt

# Did any job actually fail, or were they all cancelled?
gh run view <run-id> --json jobs \
  --jq '.jobs[] | {name, conclusion, startedAt, completedAt}'
```

All jobs `cancelled` or `success`, none `failure`, and no newer run for the
branch → external cancel. One job `failure` → a real red run that
`scripts/cancel-current-ci-run.js` then stopped on purpose.

**Account-level confirmation** (needs a scope the unattended agent cannot
grant itself — run it yourself):

```bash
gh auth refresh -s user
gh api /users/<your-login>/settings/billing/actions
```

**What PortOS already does about it**:

- One automatic retry. `.github/workflows/ci-cancel-recovery.yml` watches for a
  completed CI run and re-dispatches it exactly once when it was cancelled on a
  pull request, **no job failed**, and **no newer run exists for the branch**.
  The budget is the run attempt: `POST /rerun` produces attempt 2, and attempt
  2 is never retried. A supersession and a self-cancel after a real failure are
  both skipped, and the recovery run's own summary page states which of those
  applied. This is the layer that explains a run-wide cancel, because it is the
  only one that survives it.
- The gate reports the difference **when the gate itself runs**.
  `scripts/ci-gate-report.js` prints `this run was CANCELLED, not failed`,
  names the cancelled jobs, and points back here — instead of the old
  undifferentiated "did not pass". Note the limit: `if: always()` defeats an
  upstream failure, not a run-wide cancellation, so in the full external-cancel
  case the gate job is cancelled too and prints nothing. It covers a partial
  cancel; the recovery run covers the rest.

**A caveat worth knowing**: the retry re-runs the whole suite, Windows shards
included, so if the cause really is the spending limit then recovery spends
more of it. That is the same cost as the manual re-run it replaces, but it
means recovery is not a substitute for reducing billable minutes — tracked in
issue #7440.

If a PR is still stuck after that one retry, the queue was busy for longer than
one attempt — re-run it by hand once the other runs have drained.

One deliberate rough edge: a run **you** cancel by hand looks identical to an
external cancel from the API, so it gets the same single retry. Push a new
commit (or close the PR) rather than cancelling if you want the run to stay
stopped.

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

1. **Check logs**: `pm2 logs` shows all process output
2. **Browser console**: F12 → Console for frontend errors
3. **Server logs**: Look for emoji prefixes (❌ errors, ⚠️ warnings)
4. **GitHub Issues**: Report bugs at https://github.com/atomantic/PortOS/issues
