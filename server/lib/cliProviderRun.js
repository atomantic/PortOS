/**
 * One-shot invocation of a user-configured CLI AI provider.
 *
 * This is the single, dependency-light path for "run a prompt through whatever
 * CLI provider the user configured for this feature, get text back." It exists
 * so callers outside the main run machinery — the standalone `portos-autofixer`
 * process and the Google Calendar MCP sync — stop hardcoding `claude -p` and
 * instead honor the configured provider/model like every other AI call.
 *
 * Imports only node builtins + the pure arg builder, so the separate-process
 * autofixer (its own minimal package, only `express` installed) can import it
 * without dragging in the AI toolkit or data layer.
 *
 * For full-featured in-process runs (fallback chains, run records, SSE) use
 * `runPromptThroughProvider` in `promptRunner.js` instead. This helper is the
 * lightweight cousin for fire-and-collect prompts.
 */

import { spawn } from 'child_process';
import { buildCliArgs } from './cliProviderArgs.js';
import { killProcessTree, resolveWindowsExecutable, prepareWindowsSafeSpawn } from './bufferedSpawn.js';

/**
 * Resolve which CLI provider + model a feature should use from the providers
 * list and the feature's stored `{ providerId, model }` config.
 *
 * Only `type === 'cli'` providers are eligible: the autofixer must edit files
 * and run pm2, and the calendar sync must call MCP tools — neither works
 * through an API chat-completion provider. Resolution falls back from the
 * requested provider → `fallbackId` (default `claude-code`, the historical
 * behavior) → the first enabled CLI provider.
 *
 * @param {Array|Object} providers - array of providers OR the on-disk map keyed by id
 * @param {{ providerId?: string, model?: string, fallbackId?: string }} config
 * @returns {{ provider: object, model: string|null } | { error: string }}
 */
export function pickCliProvider(providers, config = {}) {
  const { providerId, model, fallbackId = 'claude-code' } = config || {};
  const list = Array.isArray(providers) ? providers : Object.values(providers || {});
  const cli = list.filter((p) => p && p.type === 'cli' && p.enabled !== false);
  if (cli.length === 0) {
    return { error: 'No enabled CLI provider is configured — add one under AI Providers.' };
  }

  const provider =
    (providerId && cli.find((p) => p.id === providerId)) ||
    cli.find((p) => p.id === fallbackId) ||
    cli[0];

  // Honor the requested model only when the provider actually offers it;
  // otherwise fall back to the provider's own default so a stale stored model
  // (e.g. left over from a different provider) can't pin a nonexistent id.
  const offered = Array.isArray(provider.models) ? provider.models : [];
  const resolvedModel = model && offered.includes(model) ? model : (provider.defaultModel || null);

  return { provider, model: resolvedModel };
}

/**
 * Spawn a CLI provider, deliver `prompt` via stdin (avoids OS argv limits),
 * and resolve with the collected stdout once the process exits.
 *
 * stdout and stderr are tracked separately: `text` is stdout only (the clean
 * response, safe to JSON-parse), while `onData(chunk, stream)` receives both
 * live for logging/progress. Mirrors the canonical `executeCliRun` settle
 * semantics — never rejects; failures come back as `{ error }`.
 *
 * @param {object} args
 * @param {object} args.provider - resolved CLI provider (must have `.command`)
 * @param {string|null} [args.model] - model override; applied as `defaultModel` so buildCliArgs injects it
 * @param {string} args.prompt - prompt text (sent via stdin)
 * @param {string} [args.cwd] - working directory for the child process
 * @param {string[]} [args.extraArgs] - extra argv appended after the built args (e.g. `--allowedTools …`)
 * @param {number} [args.timeoutMs] - SIGTERM after this many ms (default 300000)
 * @param {(chunk: string, stream: 'stdout'|'stderr') => void} [args.onData] - live output callback
 * @returns {Promise<{ text: string, exitCode: number, stderr: string } | { error: string, exitCode?: number, stderr?: string }>}
 */
export function runCliProviderPrompt(args = {}) {
  const { provider, model = null, prompt, cwd, extraArgs = [], timeoutMs = 300000, onData } = args;

  if (!provider?.command) {
    return Promise.resolve({ error: 'Provider has no command configured' });
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return Promise.resolve({ error: 'prompt must be a non-empty string' });
  }

  // Clone with the per-call model as defaultModel so buildCliArgs injects the
  // right --model/-m flag for this provider's CLI convention.
  const effectiveProvider = { ...provider, defaultModel: model ?? provider.defaultModel };
  const spawnArgs = [...buildCliArgs(effectiveProvider), ...(Array.isArray(extraArgs) ? extraArgs : [])];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    // CLAUDECODE is deleted from the child env so a nested invocation doesn't
    // think it's running inside the parent Claude Code session.
    const childEnv = { ...process.env, ...provider.envVars };
    delete childEnv.CLAUDECODE;

    // npm-installed CLI providers are .cmd/.bat shims on Windows; resolve+wrap
    // (cmd.exe /c) instead of enabling a shell — shell:true + an args array
    // does NOT escape arguments (DEP0190), so a prompt/path containing a
    // space would silently corrupt or be shell-injectable. Resolved against
    // `childEnv` so a provider-configured PATH override is honored. See
    // resolveWindowsExecutable/prepareWindowsSafeSpawn in
    // server/lib/bufferedSpawn.js.
    const resolvedCommand = resolveWindowsExecutable(provider.command, undefined, childEnv) || provider.command;
    const { command: spawnCommand, args: wrappedArgs } = prepareWindowsSafeSpawn(resolvedCommand, spawnArgs);
    const child = spawn(spawnCommand, wrappedArgs, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      windowsHide: true,
    });

    // Single settlement gate — the timer, spawn error, and close handler all
    // race. Without it a SIGKILL that doesn't kill synchronously lets the
    // timer fire later and settle an already-settled promise.
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (!child.killed) killProcessTree(child);
      done({ error: `Provider call timed out after ${timeoutMs}ms`, text: stdout.trim(), stderr });
    }, timeoutMs);

    // Register listeners BEFORE writing stdin so an immediate spawn failure or
    // a dead-stdin EPIPE is caught rather than thrown. A child that exits
    // before reading stdin would otherwise emit an unhandled 'error' on the
    // stdin stream — fatal in this non-request context (crashes the process).
    child.on('error', (err) => done({ error: `Failed to spawn ${provider.command}: ${err.message}` }));
    child.stdout?.on('data', (d) => { const t = d.toString(); stdout += t; onData?.(t, 'stdout'); });
    child.stderr?.on('data', (d) => { const t = d.toString(); stderr += t; onData?.(t, 'stderr'); });

    // Swallow EPIPE on stdin (child gone before/while we write) — the close/
    // error handler is the authoritative settle point; an unhandled stdin
    // 'error' would crash the process.
    child.stdin?.on('error', () => {});
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      // Synchronous write failure (e.g. already-destroyed stdin) — let the
      // 'error'/'close' handler settle the promise with the real cause.
    }

    child.on('close', (code) => {
      const text = stdout.trim();
      // A non-zero exit with no stdout is a hard failure; surface stderr.
      // Match the historical calendar-sync rule: any stdout means partial
      // success worth returning to the parser.
      if (code !== 0 && !text) {
        return done({ error: (stderr.trim().slice(0, 500) || `${provider.command} exited with code ${code}`), exitCode: code, stderr });
      }
      done({ text, exitCode: code, stderr });
    });
  });
}
