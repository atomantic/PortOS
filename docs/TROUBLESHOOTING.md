# Troubleshooting Guide

Common issues and solutions when running PortOS.

## Startup Issues

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
  - Claude: `claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`
  - OpenAI: `gpt-5`, `gpt-5-mini`
  - Ollama: Model must be pulled first (`ollama pull llama3`)

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

### Hot Reload Not Working

**Symptom**: Frontend changes require manual refresh.

**Solution**:
- Check Vite is running: `pm2 logs portos-client`
- Ensure file watchers aren't exhausted: `fs.inotify.max_user_watches`

### Tests Failing

**Solution**:
```bash
cd server
npm test

# For specific test file
npm test -- taskParser.test.js

# Watch mode for development
npm run test:watch
```

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
for the trainer (`scripts/train_mflux_lora.py`). Note per #3267 the kill is at the
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
