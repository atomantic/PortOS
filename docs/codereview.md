# PortOS Code Review

**Date:** 2026-02-25  
**Reviewer:** Copilot Agent  
**Branch:** dev  
**Scope:** Full codebase — server, client, autofixer, browser, cos-runner, configs

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Per-Module Findings](#2-per-module-findings)
3. [Cross-Cutting Concerns](#3-cross-cutting-concerns)
4. [Test Coverage Assessment](#4-test-coverage-assessment)
5. [Prioritized Recommendations](#5-prioritized-recommendations)
6. [Technical Debt Summary](#6-technical-debt-summary)
7. [Positive Observations](#7-positive-observations)

---

## 1. Architecture Overview

PortOS is a personal local-dev App OS — a monorepo with:

| Component | Tech | Port |
|-----------|------|------|
| `server/` | Express.js + Socket.IO | 5554 |
| `client/` | React 18 + Vite + Tailwind | 5555 |
| `browser/` | CDP/Playwright bridge | 5556–5557 |
| `server/cos-runner/` | Isolated PM2 agent spawner | 5558 |
| `autofixer/` | Crash detection + repair daemon | 5559–5560 |

**Data persistence:** JSON files in `./data/` — no database.  
**Process management:** PM2 with `ecosystem.config.cjs` as single source of truth for port definitions.  
**AI integration:** Delegates to `portos-ai-toolkit` npm package, shimmed via `setAIToolkit()` calls.  
**Communication:** HTTP REST + Socket.IO for real-time events (CoS logs, errors, agent status).

The design is intentional: single-user, private network, no auth/CORS hardening. That context informs all findings below.

---

## 2. Per-Module Findings

### `server/index.js` — Entry Point

- ✅ Clean initialization order, good separation of concerns.
- ✅ `asyncHandler` wrapper used consistently for error propagation.
- ✅ Lifecycle hooks for AI toolkit runs (session/message recording, error emission).
- ⚠️ **Runner patch comment misleads:** The comment says the patch fixes a `DEP0190` shell security issue, but `runner.js`'s `executeCliRun` still passes `...process.env` (including all secrets) to spawned CLI processes — intentional but worth documenting explicitly.
- 🔴 **`scaffoldRoutes` is double-mounted** at both `/api/scaffold` and `/api`. All scaffold sub-routes also respond at `/api/*`, which can shadow or conflict with other routes depending on route order. Example: `GET /api/templates` and `GET /api/scaffold/templates` both resolve.

---

### `server/routes/git.js` — Bug: App Lookup Always Fails

```js
const apps = req.app.get('apps');  // ← never set, always undefined
const app = apps?.find(a => a.id === appId);
if (!app) throw new ServerError('App not found', { status: 404 });
```

`app.set('apps', ...)` is never called in `index.js` — only `app.set('io', io)`. Every call to `GET /api/git/:appId` returns 404. The `POST /api/git/status|diff|commits` routes work fine (they accept path directly), making this a silent regression on the app-ID-based route.

**Fix:** Replace with `await appsService.getAppById(req.params.appId)` — the same pattern used by all other routes.

---

### `server/routes/scripts.js` — Inconsistent Error Handling

Scripts routes use the older `.catch(next)` pattern rather than `asyncHandler`:

```js
router.get('/', async (req, res, next) => {
  const scripts = await scriptRunner.listScripts().catch(next);
  if (scripts) res.json({ scripts });
  // If catch(next) fires, scripts = undefined and no response is sent —
  // error middleware sends the response, but the pattern is fragile.
});
```

If `listScripts()` resolves to `undefined` (edge case), no response is sent at all, leaving the request hanging. All other routes use `asyncHandler`.

**Fix:** Migrate to `asyncHandler(async (req, res) => { const scripts = await scriptRunner.listScripts(); res.json({ scripts }); })`.

---

### `server/routes/media.js` — Missing `asyncHandler`

```js
router.get('/devices', async (req, res) => {
  const devices = await mediaService.listDevices();  // unhandled rejection on throw
  res.json(devices);
});
```

No `asyncHandler` wrapping. An exception from `listDevices()` becomes an unhandled promise rejection, bypassing error middleware entirely.

**Fix:** Wrap all handlers in `asyncHandler`.

---

### `server/services/settings.js` — Unguarded `JSON.parse`

```js
const load = async () => {
  const raw = await readFile(SETTINGS_FILE, 'utf-8').catch(() => '{}');
  return JSON.parse(raw);  // throws SyntaxError if file is corrupted
};
```

The `readFile` fallback covers missing files, but not corrupted content. A partial write or disk error leaves `settings.json` with invalid JSON, causing every `getSettings()` call to throw.

Same pattern in:
- `server/services/genome.js`
- `server/services/epigenetic.js`
- `server/services/taste-questionnaire.js`
- `server/services/browserService.js` (config load + PM2 `jlist` stdout)
- `server/services/memoryBM25.js`

**Fix:** Replace `JSON.parse(raw)` with `safeJSONParse(raw, {})` from `fileUtils.js`, which already handles this correctly.

---

### `autofixer/server.js` — `exec` with String Interpolation

```js
exec(`pm2 logs ${processName} --lines 100 --nostream --err`);
```

`processName` is derived from PM2's own process list (trusted), but using `exec` with template string interpolation is an inherently unsafe pattern — if the source of `processName` ever changes, shell injection becomes possible. The `getProcessList()` function also uses bare `JSON.parse(stripped.substring(jsonStart, jsonEnd + 2))` which throws on malformed PM2 output.

**Fix:** Use `execFile('pm2', ['logs', processName, '--lines', '100', '--nostream', '--err'])`.

---

### `server/services/mediaService.js` — Device ID Argument Injection

```js
spawn('ffmpeg', ['-i', `${deviceId}:none`, ...])   // video
spawn('ffmpeg', ['-i', `:${deviceId}`, ...])         // audio
```

`deviceId` is validated only as `z.string().optional()` with no character restrictions. While `spawn` with an array prevents OS-level shell injection, FFmpeg has its own expression/filter language. A crafted `deviceId` containing a space (e.g., `"0 -vf drawtext=fontfile=/etc/passwd"`) would be passed as a single array element, but FFmpeg processes the string and would parse it. This may allow unintended FFmpeg filter injection.

**Fix:** Validate `deviceId` matches `/^\d+$/` (numeric device index only) before passing to `spawn`.

---

### `server/services/cos.js` — 4,115-Line God Class

Handles: state management, task orchestration, agent lifecycle, health checks, script management, report generation, daily/weekly digests, and more. This file is extremely difficult to test in isolation and reason about.

Split candidates:
- Health check logic (`checkHealth`, ~200 lines)
- Report generation (`generateReport`, ~100 lines)
- Script management (~100 lines, partially already in `scriptRunner.js`)
- State machine operations

Also: `` execAsync(`ps -p ${pid} -o pid= 2>/dev/null`) `` — uses `exec` with a PID from internal state. Low risk (PID is an integer) but cleaner to use `execFile('ps', ['-p', String(pid), '-o', 'pid='])`.

---

### `server/services/memory.js` — Unbounded Embeddings Cache

```js
let embeddingsCache = null;  // grows to the size of all embedding vectors
```

The embeddings cache stores ALL embedding vectors in memory with no eviction policy. At `maxMemories: 10000` with `embeddingDimension: 768`, each float32 is 4 bytes → 10,000 × 768 × 4 ≈ **30 MB** just for embeddings, growing unbounded.

The `withMemoryLock` mutex is correctly applied for write operations.

**Fix:** Implement an LRU cache with a configurable `maxCachedEmbeddings` (e.g., default 1,000), evicting least-recently-used vectors when the threshold is exceeded.

---

### `server/services/notifications.js`, `taskLearning.js`, `autonomousJobs.js` — Non-Atomic Writes Without Mutex

These services write JSON files directly with `writeFile()`, without:
1. Atomic temp-file-then-rename pattern.
2. A mutex to prevent concurrent write races.

Under high agent concurrency (multiple agents completing simultaneously and triggering saves), two concurrent `writeFile` calls to the same file can produce a corrupted result.

Compare with `instances.js` and `cos.js` state writes, which correctly use `createMutex()` + atomic rename.

**Fix:** Add `createMutex()` locks + temp-file-rename pattern (already demonstrated in `instances.js`).

---

### `server/services/subAgentSpawner.js` — 3,135 Lines, 29 Imports

Extremely complex file with deep cross-dependencies:
- Imports from 29 modules.
- Potential circular dependency: imports `cos.js` → `cosEvents.js` → back to services that import from spawner.
- `getAgentPrompt()` builds enormous LLM prompts inline (>500 lines of template strings).
- No unit tests for `spawnSubAgent()`, the core function.

**Fix:** Extract prompt-building into a pure `buildAgentPrompt(task, context)` function for isolated unit testing.

---

### `server/lib/fileUtils.js` — Well-Implemented

`safeJSONParse`, `readJSONFile`, `safeJSONLParse`, `ensureDir` are excellent shared utilities. The problem is they are not used everywhere they should be.

---

### `server/routes/uploads.js` — Good Security

- Correct path traversal prevention with `resolve()` + `startsWith(UPLOADS_DIR)` check.
- MIME type detection by extension (not magic bytes — acceptable for uploads).
- UUID prefix prevents name collisions.
- 100 MB limit enforced.

---

### `server/routes/screenshots.js` — Good Security

- Magic bytes validation for PNG/JPEG/GIF/WebP.
- Path traversal prevention.
- 10 MB limit.

---

### `server/routes/scaffold.js` — Mixed Shell Safety

`installCmd` is hardcoded (`'npm run install:all'` or `'npm install'`), so no injection risk here. The `exec` call is fine in this context. GitHub repo creation correctly uses `spawn`.

---

### `server/services/shell.js` — No Per-Socket Session Limit

The PTY shell service correctly allowlists env vars and uses `spawn` safely. However, there is no limit on how many `shell:start` events a client can send — a single client could create unlimited PTY processes.

**Fix:** Track session count per socket; reject beyond a threshold (e.g., 3 sessions) with a `shell:error` event.

---

### `server/services/instances.js` — Peer Proxy: No Loopback Block

```js
address: z.string().regex(/^((25[0-5]...)/, 'Must be a valid IP address'),
```

The IP validation enforces IPv4 format, preventing hostnames. However, there is no check that the IP is a private/internal address — adding `127.0.0.1`, `169.254.x.x` (link-local), or `0.0.0.0` as a peer causes the server to proxy requests to itself or sensitive localhost services. Low risk given the single-user private-network deployment.

**Fix:** Add a Zod refinement to reject loopback and link-local addresses.

---

### `client/src/pages/Security.jsx` — Unguarded `JSON.parse` on localStorage

```js
const saved = localStorage.getItem(MEDIA_CONSTRAINTS_KEY);
if (saved) {
  const { videoDeviceId, audioDeviceId } = JSON.parse(saved);  // crashes if corrupted
```

If localStorage data is corrupted, this silently crashes the component render.

**Fix:** Wrap in try/catch, clearing the key on failure.

---

### `server/lib/logger.js` — Dead Code

The `logger.js` module provides structured emoji-prefixed helpers (`startup`, `error`, `success`, etc.) but is **never imported anywhere**. All logging uses direct `console.log/error` calls inline. The `logger.example.js` file suggests it was intended but never adopted.

**Fix:** Either adopt it consistently across the codebase, or remove it to reduce confusion for future maintainers.

---

## 3. Cross-Cutting Concerns

### Duplicated Security Constants

`ALLOWED_COMMANDS` and `DANGEROUS_SHELL_CHARS` are defined separately in `commands.js` and `scriptRunner.js` with identical values. A change in one won't propagate to the other.

**Fix:** Extract to `server/lib/commandSecurity.js` and import from both.

---

### Three-Tier File Write Safety (Inconsistent)

| Tier | Services | Safety |
|------|----------|--------|
| Best | `instances.js`, `cos.js` state file | mutex + temp-file-then-rename |
| Middle | `apps.js`, `memory.js` | mutex but direct `writeFile` (crash during write corrupts) |
| None | `notifications.js`, `taskLearning.js`, `autonomousJobs.js`, `settings.js`, `genome.js`, `epigenetic.js` | direct `writeFile`, no mutex |

All services that own persistent JSON files should use at minimum the "Middle" tier, and ideally "Best."

---

### `asyncHandler` Consistency

97% of routes correctly use `asyncHandler`. Exceptions: `scripts.js` (`.catch(next)` pattern) and `media.js` (bare `async` functions without wrapping). These should be migrated for consistency.

---

### Hardcoded `localhost:5555` in AI Prompt Templates

`selfImprovement.js`, `taskSchedule.js`, and `cos.js` embed `localhost:5555` directly in prompts sent to AI agents. These work because agents run locally, but break silently if the UI port changes. The port is defined in `ecosystem.config.cjs` but not referenced from these strings.

**Fix:** Reference a shared constant (e.g., `process.env.PORTOS_UI_PORT || 5555`) in prompt templates.

---

## 4. Test Coverage Assessment

**Coverage threshold configured:** 30% lines/functions/branches (very low; acknowledged as a personal tool).

### Services/routes with no tests (high-value targets)

| File | Lines | Priority |
|------|-------|----------|
| `services/cos.js` | 4,115 | High |
| `services/subAgentSpawner.js` | 3,135 | High |
| `services/memory.js` | 1,061 | High |
| `services/apps.js` | ~500 | Medium |
| `services/notifications.js` | ~300 | Medium |
| `services/brain.js` | ~400 | Medium |
| `services/shell.js` | ~200 | Medium |
| `services/settings.js` | ~100 | Medium |
| `services/mediaService.js` | ~300 | Low |
| `services/jira.js` | ~400 | Low |
| `services/genome.js` | ~500 | Low |
| Most routes not listed above | various | Low |

### Services/routes with good test coverage (preserve and extend)

`lib/bm25`, `lib/fileUtils`, `lib/errorHandler`, `lib/taskParser`, `lib/validation`, `lib/vectorMath`, `services/agents`, `services/agentRunCache`, `services/autobiography`, `services/autonomousJobs`, `services/errorRecovery`, `services/executionLanes`, `services/missions`, `services/socket`, `services/taskClassifier`, `services/taskConflict`, `services/taskLearning`, `services/taskTemplates`, `services/thinkingLevels`, `services/toolStateMachine`, `services/usage`, `services/visionTest`, `services/worktreeManager`, `routes/apps`, `routes/brain`, `routes/cos`, `routes/health`, `routes/history`.

---

## 5. Prioritized Recommendations

### 🔴 Critical

**C1. Git route app lookup is broken (`server/routes/git.js`)**  
`req.app.get('apps')` is never populated in `index.js`. Every `GET /api/git/:appId` returns 404 silently.  
**Fix:** Replace with `await appsService.getAppById(req.params.appId)`.

**C2. Unguarded `JSON.parse` in `settings.js` crashes entire API on corrupt file**  
If `settings.json` is corrupted, every request that calls `getSettings()` throws an unhandled `SyntaxError`.  
**Fix:** `return safeJSONParse(raw, {})` using the existing `fileUtils.js` helper.

**C3. FFmpeg device ID argument injection (`server/services/mediaService.js`)**  
`deviceId` is passed directly to `spawn` args without format validation.  
**Fix:** Validate `deviceId` matches `/^\d+$/` before use.

---

### 🟠 High

**H1. Bare `JSON.parse` on file content in 6 services**  
`genome.js`, `epigenetic.js`, `taste-questionnaire.js`, `browserService.js` (×2), `memoryBM25.js`.  
**Fix:** Use `safeJSONParse(raw, defaultValue)` from `fileUtils.js`.

**H2. `autofixer/server.js` — `exec` with string interpolation**  
`exec(\`pm2 logs ${processName} ...\`)`.  
**Fix:** Use `execFile('pm2', ['logs', processName, ...])`.

**H3. Non-atomic writes without mutex (`notifications.js`, `taskLearning.js`, `autonomousJobs.js`)**  
Concurrent agent completions can produce corrupted JSON files.  
**Fix:** Add `createMutex()` + temp-file-rename pattern (see `instances.js` as template).

**H4. `scripts.js` routes — `.catch(next)` pattern can leave requests hanging**  
**Fix:** Migrate to `asyncHandler`.

**H5. `media.js` routes — missing `asyncHandler` wrapping**  
**Fix:** Wrap all handlers in `asyncHandler`.

**H6. `scaffoldRoutes` double-mounted at `/api` and `/api/scaffold`**  
Creates ambiguous route matching. `GET /api/templates` and `GET /api/scaffold/templates` both resolve.  
**Fix:** Remove the duplicate `/api` mount; use only `/api/scaffold`.

---

### 🟡 Medium

**M1. `cos.js` — 4,115-line god class**  
Hard to test, hard to reason about.  
**Fix:** Extract `HealthChecker`, `ReportGenerator`, `ScriptManager` into separate service files.

**M2. `subAgentSpawner.js` — 3,135 lines, core function untested**  
**Fix:** Extract prompt-building into a pure `buildAgentPrompt(task, context)` for unit testing.

**M3. Duplicate `ALLOWED_COMMANDS` / `DANGEROUS_SHELL_CHARS` constants**  
**Fix:** Extract to `server/lib/commandSecurity.js`.

**M4. Shell service — no per-socket PTY session limit**  
**Fix:** Enforce a max of ~3 concurrent PTY sessions per socket.

**M5. Memory embeddings cache — unbounded size (~30 MB at max capacity)**  
**Fix:** LRU cache with configurable `maxCachedEmbeddings`.

**M6. Hardcoded `localhost:5555` in AI prompt templates**  
**Fix:** Use `process.env.PORTOS_UI_PORT || 5555`.

**M7. `logger.js` module is dead code**  
**Fix:** Adopt it consistently, or remove it.

**M8. `Security.jsx` — unguarded `JSON.parse` on localStorage**  
**Fix:** Wrap in try/catch, clear key on failure.

**M9. `browserService.js` — `JSON.parse(stdout)` from PM2 without guard**  
**Fix:** Use `safeJSONParse(stdout, [], { allowArray: true })`.

---

### 🔵 Low

**L1. Peer IP validation doesn't reject loopback/link-local addresses**  
Low risk given single-user deployment. **Fix:** Add Zod refinement.

**L2. Test coverage threshold is only 30%**  
**Fix:** Raise to 50% lines / 40% branches as a next milestone. Prioritize `cos.js` (even just the pure parsing/state functions).

**L3. `cos.js` — `exec` with PID string for `ps`**  
Low risk. **Fix:** Use `execFile('ps', ['-p', String(pid), '-o', 'pid='])`.

**L4. `jira.js` — `allowSelfSigned: true` disables TLS without logging**  
**Fix:** Log a warning when self-signed TLS is active.

**L5. `brain.js` — `JSON.parse` on AI response without guard**  
AI can return malformed JSON. **Fix:** Wrap in try/catch.

**L6. Usage service data loaded once at startup, never reloaded from disk**  
If two PortOS instances share a data directory, usage stats diverge silently.

**L7. `settings.js` PUT — no schema validation on body**  
Any JSON can be persisted as settings. Low risk (single user), but unexpected keys could confuse future code.

---

## 6. Technical Debt Summary

| Category | Count | Details |
|----------|-------|---------|
| Bugs (broken functionality) | 1 | Git route app lookup (`routes/git.js`) |
| Crash risks (unguarded parse) | 8 | `settings.js`, `genome.js`, `epigenetic.js`, `taste-questionnaire.js`, `browserService.js` (×2), `memoryBM25.js`, `Security.jsx` |
| Security (injection/validation) | 3 | `autofixer exec`, media `deviceId`, shell session limit |
| Race conditions (no mutex) | 3 | `notifications.js`, `taskLearning.js`, `autonomousJobs.js` |
| Architecture (god classes) | 2 | `cos.js` (4,115 lines), `subAgentSpawner.js` (3,135 lines) |
| Dead code | 1 | `logger.js` module never imported |
| Duplication | 2 | `ALLOWED_COMMANDS`, `DANGEROUS_SHELL_CHARS` in two files |
| Missing tests | ~35 services/routes | Coverage threshold at 30% |
| Routing conflict | 1 | `scaffoldRoutes` double-mounted |

---

## 7. Positive Observations

The codebase has many genuinely good patterns worth preserving:

- **`asyncHandler` + `ServerError`** — clean centralized error handling throughout routes.
- **`safeJSONParse` / `readJSONFile`** in `fileUtils.js` — excellent shared primitives (the problem is they're not used universally).
- **`createMutex()`** — elegant 10-line mutex, well-applied in `instances.js`, `memory.js`, `cos.js`.
- **Shell allowlists** — both `commands.js` and `scriptRunner.js` enforce strict allowlists and metacharacter rejection.
- **`spawn` with `shell: false`** — consistently used; no shell injection via Node.js process spawning.
- **Path traversal prevention** — uploads and screenshots routes do it correctly with `resolve()` + `startsWith()`.
- **Provider API key redaction** — `sanitizeProvider()` strips keys before sending to client.
- **Error context sanitization** — `sanitizeContext()` strips credential fields from Socket.IO error events.
- **Atomic writes** in the most critical state files (`instances.json`, `cos state.json`).
- **Zod validation** on all major API inputs with `validateRequest()` helper.
- **Linkable routes** — all tabbed pages use URL params consistently, not local state.
- **`useAutoRefetch` hook** — clean shared pattern eliminating repeated `useEffect + setInterval`.
- **No hardcoded `localhost`** in client code — `window.location.hostname` used throughout.
