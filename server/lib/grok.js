/**
 * Per-CLI conventions for xAI's "Grok Build" coding agent (binary: `grok`).
 *
 * Grok Build ships three PortOS provider shapes:
 *   - `grok`      (type `api`) — OpenAI-compatible chat completions at
 *                 https://api.x.ai/v1, handled generically by the API runner.
 *   - `grok-cli`  (type `cli`) — headless one-shot via `grok --prompt-file …`.
 *   - `grok-tui`  (type `tui`) — the interactive Grok Build TUI driven over a PTY.
 *
 * Unlike every other PortOS CLI provider, grok's headless mode does NOT read the
 * prompt from raw stdin — it takes a single-turn prompt from a file path
 * (`--prompt-file <PATH>`) or an argument (`-p/--single`). To keep PortOS's
 * existing stdin delivery (`childProcess.stdin.write(prompt)`) working unchanged
 * at every spawn site, `buildCliArgs` points grok at `--prompt-file /dev/stdin`
 * on POSIX — grok opens the path and reads the piped prompt. Windows has no
 * `/dev/stdin`, so the two primary spawn helpers rewrite the sentinel to a real
 * temp file via `prepareGrokPromptFile` (see runner.js / cliProviderRun.js).
 *
 * Dependency-light on purpose: imports only `providerModels.js` helpers and node
 * builtins, mirroring `cliProviderArgs.js` so it stays importable from the
 * standalone autofixer process.
 */

import os from 'os';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { hasModelFlag, commandBasename } from './providerModels.js';

const NOOP_CLEANUP = () => {};

// True when argv contains any of `flags`, in either separated (`--flag`) or
// joined (`--flag=value`) form. The generic scan behind the grok arg builders.
const argvHasFlag = (args = [], flags) =>
  args.some((a) => typeof a === 'string' && flags.some((f) => a === f || a.startsWith(`${f}=`)));

export const GROK_API_ID = 'grok';
export const GROK_CLI_ID = 'grok-cli';
export const GROK_TUI_ID = 'grok-tui';
export const GROK_API_ENDPOINT = 'https://api.x.ai/v1';
// Grok Build's built-in default coding model (256K context). A valid `--model`
// value, so we ship it as the CLI/TUI default rather than a "configured-default"
// sentinel — grok accepts the id directly.
export const GROK_DEFAULT_MODEL = 'grok-build';

// grok reads a single-turn prompt from a file path. On POSIX we hand it
// /dev/stdin so the existing stdin write feeds it unchanged at every spawn site.
export const GROK_STDIN_PROMPT_PATH = '/dev/stdin';

/**
 * True when a provider command points at the Grok Build binary — the bare `grok`
 * on PATH, an absolute/relative path to it, or an optional Windows `.exe` suffix
 * (same matching rules as `isOpencodeCommand`/`isClaudeCommand`).
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isGrokCommand(command) {
  return commandBasename(command) === 'grok';
}

/** True for the CLI (headless) Grok provider. */
export function isGrokCliProvider(provider) {
  return provider?.id === GROK_CLI_ID
    || (provider?.type === 'cli' && isGrokCommand(provider?.command));
}

/** True for the TUI (interactive) Grok provider. */
export function isGrokTuiProvider(provider) {
  return provider?.id === GROK_TUI_ID
    || (provider?.type === 'tui' && isGrokCommand(provider?.command));
}

// A prompt source already declared (single-turn prompt, prompt file, or JSON
// blocks) — so we don't append a second `--prompt-file`.
const PROMPT_SOURCE_FLAGS = ['-p', '--single', '--prompt-file', '--prompt-json'];
// An approval/permission posture already pinned by the user.
const PERMISSION_FLAGS = ['--permission-mode', '--always-approve'];
// An output format already pinned.
const OUTPUT_FORMAT_FLAGS = ['--output-format', '-o'];

/**
 * Build the headless (one-shot) argv for the Grok Build CLI. Appends, when not
 * already pinned by the user's saved `args`:
 *   - `--output-format plain`      — PortOS parses CLI stdout as plain text.
 *   - `--permission-mode bypassPermissions` — don't block file-writing agents on
 *     approval prompts (grok's analog of `claude --dangerously-skip-permissions`).
 *   - `--model <id>`               — gated on no user-baked model flag.
 *   - `--prompt-file /dev/stdin`   — deliver the prompt over stdin (POSIX); the
 *     spawn helper rewrites this to a temp file on Windows.
 * @param {string[]} baseArgs - user/legacy args (already model-flag-sanitized)
 * @param {string|null|undefined} model - defaultModel to pin, or null to omit
 * @returns {string[]}
 */
export function ensureGrokHeadlessArgs(baseArgs = [], model) {
  const out = [...baseArgs];
  if (!argvHasFlag(out, OUTPUT_FORMAT_FLAGS)) {
    out.push('--output-format', 'plain');
  }
  if (!argvHasFlag(out, PERMISSION_FLAGS)) {
    out.push('--permission-mode', 'bypassPermissions');
  }
  if (model && !hasModelFlag(out)) {
    out.push('--model', model);
  }
  if (!argvHasFlag(out, PROMPT_SOURCE_FLAGS)) {
    out.push('--prompt-file', GROK_STDIN_PROMPT_PATH);
  }
  return out;
}

/**
 * Ensure the interactive Grok TUI argv auto-approves tool executions so a
 * file-writing agent isn't stranded on an approval prompt (mirrors the codex
 * `--dangerously-bypass-approvals-and-sandbox` / antigravity
 * `--dangerously-skip-permissions` TUI defaults). Idempotent when the user
 * already pinned a permission posture.
 * @param {string[]} args
 * @returns {string[]}
 */
export function ensureGrokTuiArgs(args = []) {
  const out = [...args];
  if (!argvHasFlag(out, PERMISSION_FLAGS)) {
    out.push('--permission-mode', 'bypassPermissions');
  }
  return out;
}

/**
 * Resolve how the prompt reaches grok for a spawned headless run.
 *
 * POSIX: the `--prompt-file /dev/stdin` sentinel stays put and the caller feeds
 * the prompt via stdin exactly as for every other CLI (`useStdin: true`).
 *
 * Windows: `/dev/stdin` doesn't exist, so write the prompt to a real temp file,
 * rewrite the argv to point `--prompt-file` at it, and tell the caller to skip
 * the stdin write (`useStdin: false`). `cleanup()` removes the temp file and
 * must be invoked from the child's close/error handler.
 *
 * A no-op (returns the argv untouched, `useStdin: true`) for any argv that isn't
 * the grok stdin sentinel, so it's safe to call unconditionally before a spawn.
 * @param {string[]} args - the built argv (may contain the /dev/stdin sentinel)
 * @param {string} prompt - the prompt text
 * @returns {{ args: string[], useStdin: boolean, cleanup: () => void }}
 */
export function prepareGrokPromptFile(args, prompt) {
  if (process.platform !== 'win32') return { args, useStdin: true, cleanup: NOOP_CLEANUP };
  const idx = args.indexOf(GROK_STDIN_PROMPT_PATH);
  if (idx <= 0 || args[idx - 1] !== '--prompt-file') return { args, useStdin: true, cleanup: NOOP_CLEANUP };
  const file = join(os.tmpdir(), `grok-prompt-${process.pid}-${Date.now()}.txt`);
  writeFileSync(file, typeof prompt === 'string' ? prompt : '', 'utf8');
  const rewritten = [...args];
  rewritten[idx] = file;
  return {
    args: rewritten,
    useStdin: false,
    cleanup: () => { try { unlinkSync(file); } catch { /* already gone */ } },
  };
}
