import { mkdir, readFile, readdir, rm } from 'fs/promises';
import { atomicWrite } from './internal/atomicWrite.js';
import { existsSync } from 'fs';
import { join, extname, basename, isAbsolute, delimiter } from 'path';
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { analyzeError, analyzeHttpError, ERROR_CATEGORIES } from './errorDetection.js';

// npm-installed CLI providers (claude, codex, opencode, …) are .cmd/.bat
// shims on Windows; Node's spawn() can't execute those without going through
// cmd.exe. Mirrors `server/lib/bufferedSpawn.js`'s IS_WIN32/killProcessTree/
// resolveWindowsExecutable pattern — duplicated rather than imported, since
// this directory must stay self-contained (see ./CLAUDE.md).
const IS_WIN32 = process.platform === 'win32';

// Extensions Windows can launch directly, checked in cmd.exe's own resolution
// preference. Deliberately excludes an extension-less match — npm ships a
// POSIX shell-script stub alongside a package's `.cmd`/`.bat`/`.ps1` Windows
// wrappers (for Git Bash/WSL), and that stub is not natively launchable here.
const WIN_EXECUTABLE_EXTS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Resolve a bare command name to its full path WITH extension on Windows, so
 * the caller knows exactly which file (and which kind — `.exe` vs
 * `.cmd`/`.bat`) it's about to launch. Filesystem-only (no subprocess). See
 * server/lib/bufferedSpawn.js's `resolveWindowsExecutable` docstring for the
 * full root-cause explanation (including why `searchEnv` matters — a
 * provider-configured PATH override), mirrored here for self-containment.
 * Pair with `prepareWindowsSafeSpawn` below to get a launchable
 * `{ command, args }`.
 */
function resolveWindowsExecutable(command, isWin32 = IS_WIN32, searchEnv = process.env) {
  if (!isWin32 || !command || isAbsolute(command) || /[\\/]/.test(command)) return null;
  const pathDirs = (searchEnv.PATH || searchEnv.Path || '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of WIN_EXECUTABLE_EXTS) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const WIN_BATCH_EXT_RE = /\.(cmd|bat)$/i;

/**
 * Return the `{ command, args }` pair that's actually safe to hand to
 * `spawn()` under `shell:false` — THE ACTUAL FIX FOR #1865. `.bat`/`.cmd`
 * files cannot be launched directly under `shell:false` even with the
 * explicit extension (Node's CVE-2024-27980 patch makes `spawn()` refuse
 * them outright, full stop — it does NOT safely auto-wrap them). Node's
 * documented safe alternative is to spawn `cmd.exe /c <path> <args>`
 * directly: `cmd.exe` is a normal `.exe`, so Node's existing, already-tested
 * non-shell argv→command-line escaping governs the result, with none of
 * `shell:true`'s DEP0190 unescaped-join hazard. Mirrors
 * server/lib/bufferedSpawn.js's `prepareWindowsSafeSpawn` for self-containment.
 */
function prepareWindowsSafeSpawn(command, args, isWin32 = IS_WIN32) {
  if (isWin32 && WIN_BATCH_EXT_RE.test(command)) {
    return {
      command: 'cmd.exe',
      args: ['/c', escapeCmdMetacharsIfUnquoted(command), ...args.map(escapeCmdMetacharsIfUnquoted)],
    };
  }
  return { command, args };
}

// cmd.exe metacharacters that act as command separators / redirection /
// grouping on its raw command line.
const CMD_METACHAR_RE = /[&|<>^()]/g;
// Node's argv→command-line quoting wraps an argument in literal double
// quotes only when it contains whitespace or a `"`; characters inside that
// quoted span are not re-interpreted by cmd.exe.
const NEEDS_NODE_QUOTING_RE = /[\s"]/;

/**
 * Caret-escape cmd.exe metacharacters, but ONLY when Node's own quoting
 * would otherwise leave the argument unquoted on cmd.exe's raw command line
 * (an argument WITH whitespace is already double-quoted by Node, and
 * caret-escaping it too would inject literal `^` into the value the target
 * program receives). Mirrors server/lib/bufferedSpawn.js for self-containment.
 */
function escapeCmdMetacharsIfUnquoted(value) {
  const str = String(value);
  if (NEEDS_NODE_QUOTING_RE.test(str)) return str;
  return str.replace(CMD_METACHAR_RE, '^$&');
}

// On Windows, taskkill (used below) runs in a separate detached process that
// never touches the original ChildProcess object — `.killed` is set
// synchronously here (mirroring what Node's own `child.kill()` does on the
// POSIX branch) so callers elsewhere that gate re-entrant kill handling on
// `.killed` actually engage on Windows. A plain SIGTERM kills the cmd.exe
// wrapper but orphans the real child, so the whole process tree is taken
// down via `taskkill /T /F` there; SIGTERM is sufficient elsewhere.
//
// The win32 branch is gated on `instanceof ChildProcess`: stopRun/deleteRun
// below call this with whatever was registered via registerExternalRun,
// which can be a node-pty `IPty` TUI session (server/lib/tuiPromptRunner.js,
// via the host's registerActiveRun) — it also exposes `.kill()`/`.pid`, but
// a raw `taskkill` against its pid bypasses node-pty's own Windows teardown
// (releasing its native ConPTY handle), leaking it. Any non-ChildProcess
// killable always uses its own `.kill()` instead, on every platform.
function killProcessTree(child) {
  if (IS_WIN32 && child.pid && child instanceof ChildProcess) {
    child.killed = true;
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
      .on('error', () => {})
      .unref();
  } else {
    child.kill('SIGTERM');
  }
}

// Invoke a completion hook / callback so a throw is logged but never
// propagates — these run at out-of-request boundaries where an uncaught throw
// is an unhandled rejection that crashes the process. Each call is isolated so
// a throwing hook can't prevent a later `onComplete` from settling the caller.
// Handles both a synchronous throw AND a rejected promise from an async hook —
// the latter would otherwise surface as an unhandled rejection.
function safeSettle(fn, label) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.catch(err => console.error(`❌ ${label} threw during recovery: ${err.message}`));
    }
  } catch (err) {
    console.error(`❌ ${label} threw during recovery: ${err.message}`);
  }
}

export function createRunnerService(config = {}) {
  const {
    dataDir = './data',
    runsDir = 'runs',
    screenshotsDir = './data/screenshots',
    providerService,
    providerStatusService = null,
    hooks = {},
    maxConcurrentRuns: _maxConcurrentRuns = 5
  } = config;

  const RUNS_PATH = join(dataDir, runsDir);
  const activeRuns = new Map();

  // ── Declared extension points ────────────────────────────────────────────
  // PortOS supplies a CLI runner that knows per-CLI argv conventions (Codex
  // `exec -`, Antigravity `agy --print`, Claude Code `-p -`) and a TUI runner
  // the toolkit has no built-in for. Rather than reaching into private props
  // from server/index.js, the host registers them via setCliRunner/setTuiRunner.
  // Externally-spawned runs (the host owns their child process / pty) are tracked
  // in `externalRuns` so the toolkit's stopRun/isRunActive/deleteRun see them.
  // See server/lib/aiToolkit/CLAUDE.md (override contract).
  let cliRunnerOverride = null;
  const externalRuns = new Map();

  async function ensureRunsDir() {
    if (!existsSync(RUNS_PATH)) {
      await mkdir(RUNS_PATH, { recursive: true });
    }
  }

  function getMimeType(filepath) {
    const ext = extname(filepath).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    return mimeTypes[ext] || 'image/png';
  }

  async function loadImageAsBase64(imagePath) {
    if (typeof imagePath !== 'string' || !imagePath) {
      throw new Error(`Invalid screenshot path: ${imagePath}`);
    }
    // Relative references are anchored under screenshotsDir with `basename`
    // applied, so a `../`-traversal collapses to a bare filename and can't
    // escape the screenshots dir. Absolute paths come only from trusted
    // in-process callers (e.g. PortOS's Universe Builder, whose
    // `resolveImageSources` has already validated them against an approved
    // image root) and pass through unchanged. The untrusted POST /api/runs
    // surface is additionally sanitized at the route boundary
    // (sanitizeScreenshotRefs in routes/runs.js) so an attacker-supplied
    // absolute path never reaches this loader. See issue #1870 / #1820.
    const fullPath = isAbsolute(imagePath)
      ? imagePath
      : join(screenshotsDir, basename(imagePath));

    if (!existsSync(fullPath)) {
      throw new Error(`Image not found: ${fullPath}`);
    }

    const buffer = await readFile(fullPath);
    const mimeType = getMimeType(fullPath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  function safeJsonParse(str, fallback = {}) {
    if (typeof str !== 'string' || !str.trim()) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(str);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  async function handleProviderError(providerId, errorAnalysis, output) {
    hooks.onProviderError?.(providerId, errorAnalysis, output);

    if (providerStatusService) {
      if (errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT && errorAnalysis.requiresFallback) {
        await providerStatusService.markUsageLimit(providerId, {
          message: errorAnalysis.message,
          waitTime: errorAnalysis.waitTime
        }).catch(err => {
          console.error(`❌ Failed to mark provider usage limit: ${err.message}`);
        });
      } else if (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT) {
        await providerStatusService.markRateLimited(providerId).catch(err => {
          console.error(`❌ Failed to mark provider rate limited: ${err.message}`);
        });
      }
    }
  }

  const service = {
    // ── Extension-point setters / external-run registry ──────────────────
    // Register a host CLI runner. Pass `null` to revert to the toolkit's
    // built-in executeCliRun. The override receives the same args the built-in
    // would and must return the runId.
    setCliRunner(fn) {
      if (fn != null && typeof fn !== 'function') {
        throw new Error('setCliRunner expects a function or null');
      }
      cliRunnerOverride = fn;
    },
    // Register a host TUI runner. The toolkit has no built-in TUI executor, so
    // the runs router gates on `typeof runnerService.executeTuiRun === 'function'`.
    // Attaching/detaching the method keeps that gate honest.
    setTuiRunner(fn) {
      if (fn != null && typeof fn !== 'function') {
        throw new Error('setTuiRunner expects a function or null');
      }
      if (fn) service.executeTuiRun = fn;
      else delete service.executeTuiRun;
    },
    // Track a host-spawned run's killable handle (ChildProcess or node-pty IPty —
    // both expose `.kill(signal?)`; AbortController exposes `.abort()`) so
    // stopRun/isRunActive/deleteRun account for it alongside the toolkit's own.
    registerExternalRun(runId, killable) { externalRuns.set(runId, killable); },
    unregisterExternalRun(runId) { externalRuns.delete(runId); },
    hasExternalRun(runId) { return externalRuns.has(runId); },

    async createRun(options) {
      const {
        providerId,
        model,
        prompt,
        workspacePath = process.cwd(),
        workspaceName = 'default',
        timeout,
        source = 'devtools',
        fallbackProviderId = null
      } = options;

      if (!providerService) {
        throw new Error('Provider service not configured');
      }

      let effectiveProviderId = providerId;
      let usedFallback = false;
      // Model hint to run on the fallback provider when we proactively swap
      // below. Stays null on the non-fallback path so the requested `model`
      // wins as before.
      let fallbackModelHint = null;

      if (providerStatusService && !providerStatusService.isAvailable(providerId)) {
        const allProviders = await providerService.getAllProviders();
        const providersMap = {};
        for (const p of allProviders.providers) {
          providersMap[p.id] = p;
        }

        const fallback = providerStatusService.getFallbackProvider(
          providerId,
          providersMap,
          fallbackProviderId
        );

        if (fallback) {
          effectiveProviderId = fallback.provider.id;
          usedFallback = true;
          fallbackModelHint = fallback.model || null;
          // Name the benched PRIMARY and why it was skipped, not just the
          // fallback — otherwise the log reads as an unexplained provider switch
          // ("why is my enabled provider not being used?"). `enabled` is the user
          // toggle; this swap is driven by the separate runtime availability state.
          const benched = providerStatusService.getStatus(providerId) || {};
          const recovery = providerStatusService.getTimeUntilRecovery(providerId);
          const primaryName = providersMap[providerId]?.name || providerId;
          console.log(`⚡ Primary ${primaryName} unavailable (${benched.reason || 'unknown'}${recovery ? `, recovers in ${recovery}` : ''}) — using fallback ${fallback.provider.name} (source: ${fallback.source})`);
        } else {
          const timeUntilRecovery = providerStatusService.getTimeUntilRecovery(providerId);
          throw new Error(
            `Provider ${providerId} is unavailable (${providerStatusService.getStatus(providerId).reason}) ` +
            `and no fallback is available. Recovery in: ${timeUntilRecovery || 'unknown'}`
          );
        }
      }

      const provider = await providerService.getProviderById(effectiveProviderId);
      if (!provider) {
        throw new Error('Provider not found');
      }

      if (!provider.enabled) {
        throw new Error('Provider is disabled');
      }

      await ensureRunsDir();

      const runId = randomUUID();
      const runDir = join(RUNS_PATH, runId);
      await mkdir(runDir);

      // On fallback, the requested `model` was resolved against the PRIMARY
      // provider and almost never exists on the fallback — use the configured
      // fallback model (or the fallback provider's own default) instead of
      // leaking the primary's model id onto the fallback's record + log line.
      const recordModel = usedFallback
        ? (fallbackModelHint || provider.defaultModel || null)
        : (model || provider.defaultModel || null);

      const metadata = {
        id: runId,
        type: 'ai',
        providerId: effectiveProviderId,
        providerName: provider.name,
        originalProviderId: usedFallback ? providerId : null,
        usedFallback,
        model: recordModel,
        workspacePath,
        workspaceName,
        source,
        prompt: prompt.substring(0, 500),
        // Full prompt size (chars) — `prompt` above is truncated for display.
        // Hosts use this to estimate input-token usage on completion.
        promptLength: prompt.length,
        startTime: new Date().toISOString(),
        endTime: null,
        duration: null,
        exitCode: null,
        success: null,
        error: null,
        errorCategory: null,
        errorAnalysis: null,
        outputSize: 0
      };

      await atomicWrite(join(runDir, 'metadata.json'), metadata);
      await atomicWrite(join(runDir, 'prompt.txt'), prompt);
      await atomicWrite(join(runDir, 'output.txt'), '');

      hooks.onRunCreated?.(metadata);
      console.log(`🤖 AI run [${source}]: ${provider.name}/${metadata.model}`);

      const effectiveTimeout = timeout || provider.timeout;

      // Surface `fallbackModel` so callers that re-resolve the model against
      // the fallback provider (e.g. stageRunner's args-baked-model logic) use
      // the configured fallback model instead of the primary's leaked one.
      return { runId, runDir, provider, metadata, timeout: effectiveTimeout, usedFallback, fallbackModel: fallbackModelHint };
    },

    async executeCliRun(opts) {
      // A host-registered CLI runner (see setCliRunner) wins — it tracks its own
      // child process via registerExternalRun, so stopRun/isRunActive/deleteRun
      // still account for it.
      if (cliRunnerOverride) return cliRunnerOverride(opts);
      const { runId, provider, prompt, workspacePath, onData, onComplete, timeout } = opts;
      const runDir = join(RUNS_PATH, runId);
      const outputPath = join(runDir, 'output.txt');
      const metadataPath = join(runDir, 'metadata.json');

      const startTime = Date.now();
      let output = '';

      // Pass the prompt via stdin (not argv) and run without a shell so that
      // user-configurable `provider.command` cannot inject extra commands via
      // shell metacharacters, and so the full prompt isn't visible in
      // process listings as a single command-line argument. On Windows,
      // resolve+wrap a .cmd/.bat target instead of enabling a shell — see
      // prepareWindowsSafeSpawn above for why shell:true is unsafe here.
      const args = [...(provider.args || [])];
      console.log(`🚀 Executing CLI: ${provider.command} ${args.join(' ')} (${prompt.length} chars via stdin)`);

      const childEnv = { ...process.env, ...provider.envVars };
      // Resolved against `childEnv` (not bare process.env) so a
      // provider-configured PATH override is honored.
      const resolvedCommand = resolveWindowsExecutable(provider.command, undefined, childEnv) || provider.command;
      const { command: spawnCommand, args: spawnArgs } = prepareWindowsSafeSpawn(resolvedCommand, args);
      const childProcess = spawn(spawnCommand, spawnArgs, {
        cwd: workspacePath,
        env: childEnv,
        windowsHide: true
      });
      if (childProcess.stdin) {
        childProcess.stdin.write(prompt);
        childProcess.stdin.end();
      }

      activeRuns.set(runId, childProcess);
      hooks.onRunStarted?.({ runId, provider: provider.name, model: provider.defaultModel });

      const timeoutHandle = setTimeout(() => {
        if (childProcess && !childProcess.killed) {
          console.log(`⏱️ Run ${runId} timed out after ${timeout}ms`);
          killProcessTree(childProcess);
        }
      }, timeout);

      childProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        output += text;
        onData?.(text);
      });

      childProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        output += text;
        onData?.(text);
      });

      childProcess.on('close', async (code) => {
        // Runs outside the request lifecycle — an uncaught throw from
        // atomicWrite/handleProviderError/hooks would surface as an unhandled
        // rejection and crash the process, so guard the body and still settle
        // the caller on failure.
        try {
          clearTimeout(timeoutHandle);
          activeRuns.delete(runId);

          await atomicWrite(outputPath, output);

          const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
          metadata.endTime = new Date().toISOString();
          metadata.duration = Date.now() - startTime;
          metadata.exitCode = code;
          metadata.success = code === 0;
          metadata.outputSize = Buffer.byteLength(output);

          if (!metadata.success) {
            const errorAnalysis = analyzeError(output, code);
            metadata.error = errorAnalysis.message || `Process exited with code ${code}`;
            metadata.errorCategory = errorAnalysis.category;
            metadata.errorAnalysis = errorAnalysis;

            if (errorAnalysis.hasError &&
                (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT ||
                 errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT)) {
              await handleProviderError(provider.id, errorAnalysis, output);
            }
          }

          await atomicWrite(metadataPath, metadata);

          // Isolate the completion hooks + onComplete from the outer catch — a
          // throwing onRunCompleted must NOT be reinterpreted as a finalization
          // failure that flips a successful run to success:false for the caller.
          if (metadata.success) {
            safeSettle(() => hooks.onRunCompleted?.(metadata, output), `Run ${runId} onRunCompleted hook`);
          } else {
            safeSettle(() => hooks.onRunFailed?.(metadata, metadata.error, output), `Run ${runId} onRunFailed hook`);
          }
          safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
        } catch (err) {
          console.error(`❌ Run ${runId} close handler error: ${err.message}`);
          const failMetadata = {
            endTime: new Date().toISOString(),
            duration: Date.now() - startTime,
            exitCode: code,
            success: false,
            error: `Run finalization failed: ${err.message}`,
            outputSize: Buffer.byteLength(output),
          };
          safeSettle(() => hooks.onRunFailed?.(failMetadata, failMetadata.error, output), `Run ${runId} onRunFailed hook`);
          safeSettle(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
        }
      });

      return runId;
    },

    async executeApiRun({ runId, provider, model, prompt, workspacePath, screenshots, onData, onComplete }) {
      const runDir = join(RUNS_PATH, runId);
      const outputPath = join(runDir, 'output.txt');
      const metadataPath = join(runDir, 'metadata.json');

      const startTime = Date.now();
      let output = '';

      const headers = {
        'Content-Type': 'application/json'
      };
      if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      const controller = new AbortController();
      activeRuns.set(runId, controller);

      hooks.onRunStarted?.({ runId, provider: provider.name, model });

      let messageContent;
      if (screenshots && screenshots.length > 0) {
        console.log(`📸 Loading ${screenshots.length} screenshots for vision API`);
        const contentParts = [];

        for (const screenshotPath of screenshots) {
          const imageDataUrl = await loadImageAsBase64(screenshotPath).catch(err => {
            console.error(`❌ Failed to load screenshot ${screenshotPath}: ${err.message}`);
            return null;
          });
          if (imageDataUrl) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: imageDataUrl }
            });
          }
        }

        contentParts.push({ type: 'text', text: prompt });
        messageContent = contentParts;
      } else {
        messageContent = prompt;
      }

      const ensureProviderReady = hooks.ensureProviderReady || (async () => ({ success: true }));
      const ready = await ensureProviderReady(provider).catch((err) => ({ success: false, error: err.message }));
      const response = ready.success
        ? await fetch(`${provider.endpoint}/chat/completions`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
              model: model || provider.defaultModel,
              messages: [{ role: 'user', content: messageContent }],
              stream: true,
              // Ollama's OpenAI-compatible endpoint defaults to a ~4K context
              // window and silently truncates longer prompts. A top-level
              // num_ctx lifts it (honored by Ollama, ignored by other
              // OpenAI-style endpoints). Only sent when the provider opts in.
              ...(Number(provider.numCtx) > 0 ? { num_ctx: Number(provider.numCtx) } : {})
            })
          }).catch(err => ({ ok: false, error: err.message, status: 0 }))
        : { ok: false, error: `Ollama is not running and PortOS could not start it: ${ready.error || 'unknown error'}`, status: 0 };

      if (!response.ok) {
        activeRuns.delete(runId);
        const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
        metadata.endTime = new Date().toISOString();
        metadata.duration = Date.now() - startTime;
        metadata.success = false;

        let responseBody = response.error || '';
        if (response.text) {
          responseBody = await response.text().catch(() => response.error || '');
        }

        const errorAnalysis = analyzeHttpError({
          status: response.status || 0,
          statusText: response.statusText || '',
          body: responseBody
        });

        metadata.error = errorAnalysis.message || `API error: ${response.status}`;
        metadata.errorCategory = errorAnalysis.category;
        metadata.errorAnalysis = errorAnalysis;

        if (errorAnalysis.hasError &&
            (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT ||
             errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT)) {
          await handleProviderError(provider.id, errorAnalysis, responseBody);
        }

        await atomicWrite(metadataPath, metadata);

        hooks.onRunFailed?.(metadata, metadata.error, '');
        onComplete?.(metadata);
        return runId;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let reasoning = '';

      const processStream = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

          for (const line of lines) {
            const data = line.slice(6);
            if (data === '✅' || data === '[DONE]') continue;

            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta;

            if (delta?.content) {
              const text = delta.content;
              output += text;
              onData?.({ text });
            }

            if (delta?.reasoning) {
              reasoning += delta.reasoning;
            }
          }
        }

        // Capture the fallback decision BEFORE mutating `output` — otherwise
        // the metadata check below (`!output.trim() && reasoning.trim()`) is
        // always false on the reasoning-only path because `output` was just
        // overwritten with the reasoning text.
        const usedReasoningAsFallback = !output.trim() && reasoning.trim().length > 0;
        if (usedReasoningAsFallback) {
          console.log(`🧠 Reasoning model detected - using reasoning as output (${reasoning.length} chars)`);
          output = reasoning;
          onData?.({ text: reasoning, isReasoning: true });
        }

        await atomicWrite(outputPath, output);
        activeRuns.delete(runId);

        const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
        metadata.endTime = new Date().toISOString();
        metadata.duration = Date.now() - startTime;
        metadata.exitCode = 0;
        metadata.success = true;
        metadata.outputSize = Buffer.byteLength(output);
        metadata.hadReasoning = reasoning.length > 0;
        metadata.usedReasoningAsFallback = usedReasoningAsFallback;
        await atomicWrite(metadataPath, metadata);

        hooks.onRunCompleted?.(metadata, output);
        onComplete?.(metadata);
      };

      processStream().catch(async (err) => {
        // This catch runs detached (the promise is not awaited), so an
        // unguarded throw from handleProviderError/atomicWrite below would
        // surface as an unhandled rejection and crash the process. Wrap it.
        try {
          activeRuns.delete(runId);

          if (output) {
            await atomicWrite(outputPath, output).catch(() => {});
          }

          const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
          metadata.endTime = new Date().toISOString();
          metadata.duration = Date.now() - startTime;
          metadata.success = false;

          const errorAnalysis = analyzeError(err.message);
          metadata.error = errorAnalysis.message || err.message;
          metadata.errorCategory = errorAnalysis.category;
          metadata.errorAnalysis = errorAnalysis;
          metadata.outputSize = Buffer.byteLength(output);

          if (errorAnalysis.hasError &&
              (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT ||
               errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT)) {
            await handleProviderError(provider.id, errorAnalysis, output);
          }

          await atomicWrite(metadataPath, metadata);

          // Isolate the hook + onComplete so a throwing onRunFailed doesn't
          // bounce into the recovery path and call onRunFailed a second time.
          safeSettle(() => hooks.onRunFailed?.(metadata, metadata.error, output), `Run ${runId} onRunFailed hook`);
          safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
        } catch (handlerErr) {
          console.error(`❌ Run ${runId} failure handler error: ${handlerErr.message}`);
          // Still settle callers waiting on onComplete so a persistence/hook
          // failure surfaces as a failed run instead of hanging forever. Isolate
          // the hook from onComplete — a throwing onRunFailed must NOT prevent
          // onComplete from settling the caller.
          const failMetadata = {
            endTime: new Date().toISOString(),
            duration: Date.now() - startTime,
            success: false,
            error: `Run finalization failed: ${handlerErr.message}`,
            outputSize: Buffer.byteLength(output),
          };
          safeSettle(() => hooks.onRunFailed?.(failMetadata, failMetadata.error, output), `Run ${runId} onRunFailed hook`);
          safeSettle(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
        }
      });

      return runId;
    },

    async stopRun(runId) {
      // Host-spawned runs (CLI/TUI) take precedence — kill the registered handle
      // and drop it so a later isRunActive reports false.
      const external = externalRuns.get(runId);
      if (external) {
        if (external.kill && !external.killed) killProcessTree(external);
        else if (external.abort) external.abort();
        externalRuns.delete(runId);
        return true;
      }

      const active = activeRuns.get(runId);
      if (!active) return false;

      if (active.kill) {
        killProcessTree(active);
      } else if (active.abort) {
        active.abort();
      }

      activeRuns.delete(runId);
      return true;
    },

    async getRun(runId) {
      const runDir = join(RUNS_PATH, runId);
      if (!existsSync(runDir)) return null;

      const metadata = safeJsonParse(await readFile(join(runDir, 'metadata.json'), 'utf-8').catch(() => '{}'));
      return metadata;
    },

    async getRunOutput(runId) {
      const runDir = join(RUNS_PATH, runId);
      if (!existsSync(runDir)) return null;

      return readFile(join(runDir, 'output.txt'), 'utf-8');
    },

    async getRunPrompt(runId) {
      const runDir = join(RUNS_PATH, runId);
      if (!existsSync(runDir)) return null;

      return readFile(join(runDir, 'prompt.txt'), 'utf-8');
    },

    async listRuns(limit = 50, offset = 0, source = 'all') {
      await ensureRunsDir();

      const entries = await readdir(RUNS_PATH, { withFileTypes: true });
      const runIds = entries.filter(e => e.isDirectory()).map(e => e.name);

      const runs = [];
      for (const runId of runIds) {
        const metadataPath = join(RUNS_PATH, runId, 'metadata.json');
        if (existsSync(metadataPath)) {
          const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
          if (metadata.id) runs.push(metadata);
        }
      }

      let filteredRuns = runs;
      if (source !== 'all') {
        filteredRuns = runs.filter(run => {
          const runSource = run.source || 'devtools';
          return runSource === source;
        });
      }

      filteredRuns.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

      return {
        total: filteredRuns.length,
        runs: filteredRuns.slice(offset, offset + limit)
      };
    },

    async deleteRun(runId) {
      // Kill an in-flight host-spawned run before removing its dir so deleting a
      // live run doesn't leave a zombie child process behind.
      if (externalRuns.has(runId)) {
        await service.stopRun(runId);
      }

      const runDir = join(RUNS_PATH, runId);
      if (!existsSync(runDir)) return false;

      await rm(runDir, { recursive: true });
      return true;
    },

    async deleteFailedRuns() {
      await ensureRunsDir();

      const entries = await readdir(RUNS_PATH, { withFileTypes: true });
      const runIds = entries.filter(e => e.isDirectory()).map(e => e.name);

      let deletedCount = 0;
      for (const runId of runIds) {
        const metadataPath = join(RUNS_PATH, runId, 'metadata.json');
        if (existsSync(metadataPath)) {
          const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
          if (metadata.success === false) {
            await rm(join(RUNS_PATH, runId), { recursive: true });
            deletedCount++;
          }
        }
      }

      return deletedCount;
    },

    async isRunActive(runId) {
      return externalRuns.has(runId) || activeRuns.has(runId);
    }
  };

  return service;
}
