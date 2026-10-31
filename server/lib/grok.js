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
 * standalone autofixer process. Speed pairing stays in this file; the
 * `grok models` probe lives in `grokModelCatalog.js` so this module does not
 * spawn a process.
 */

import { isCliProvider, isTuiProvider } from './providerTypes.js';
import os from 'os';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { argvHasFlag, hasModelFlag, commandBasename, GROK_CONFIGURED_DEFAULT } from './providerModels.js';

const NOOP_CLEANUP = () => {};

export const GROK_API_ID = 'grok';
export const GROK_CLI_ID = 'grok-cli';
export const GROK_TUI_ID = 'grok-tui';
export const GROK_API_ENDPOINT = 'https://api.x.ai/v1';
// Shipped CLI/TUI providers pin a concrete model for accurate attribution.
// Legacy configured-default selections still omit --model for compatibility.

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
    || (isCliProvider(provider) && isGrokCommand(provider?.command));
}

/** True for the TUI (interactive) Grok provider. */
export function isGrokTuiProvider(provider) {
  return provider?.id === GROK_TUI_ID
    || (isTuiProvider(provider) && isGrokCommand(provider?.command));
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
 *     With `toolFree` (a one-shot answer over caller text — Ask, AI app
 *     detection, #9008) it is the read-only `plan` mode instead; the caller
 *     then runs `toolFreeOneShotArgs` to empty the tool allowlist too.
 *   - `--model <id>`               — gated on no user-baked model flag.
 *   - `--prompt-file /dev/stdin`   — deliver the prompt over stdin (POSIX); the
 *     spawn helper rewrites this to a temp file on Windows.
 * @param {string[]} baseArgs - user/legacy args (already model-flag-sanitized)
 * @param {string|null|undefined} model - defaultModel to pin, or null to omit
 * @param {{ toolFree?: boolean }} [options]
 * @returns {string[]}
 */
export function ensureGrokHeadlessArgs(baseArgs = [], model, { toolFree = false } = {}) {
  const out = [...baseArgs];
  if (!argvHasFlag(out, OUTPUT_FORMAT_FLAGS)) {
    out.push('--output-format', 'plain');
  }
  if (!argvHasFlag(out, PERMISSION_FLAGS)) {
    out.push('--permission-mode', toolFree ? 'plan' : 'bypassPermissions');
  }
  if (model && !hasModelFlag(out)) {
    out.push('--model', model);
  }
  if (!argvHasFlag(out, PROMPT_SOURCE_FLAGS)) {
    out.push('--prompt-file', GROK_STDIN_PROMPT_PATH);
  }
  return out;
}

// `--output-format plain` concatenates every assistant text chunk of the run with
// no separator, so the "I'll inspect the code first." narration grok writes
// before a tool call lands glued to the answer (`…first.{"verdict":…}`), and a
// strict-JSON caller (the code reviewer) can never parse the reply (#14391).
// `streaming-json` keeps tool calls as their own events, which marks where the
// final message starts.
export const GROK_STREAMING_JSON_FORMAT = 'grok-streaming-json';

/**
 * Point a built grok argv at `--output-format streaming-json`, replacing any
 * format already present. Pair with `extractGrokFinalMessage`.
 * @param {string[]} args
 * @returns {string[]}
 */
export function withGrokStreamingJsonOutput(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output-format' || args[i] === '-o') i++;
    else if (!args[i].startsWith('--output-format=')) out.push(args[i]);
  }
  return [...out, '--output-format', 'streaming-json'];
}

/**
 * Reduce a grok `streaming-json` transcript to its final message: the `text`
 * chunks after the last tool call. Thought, usage and command-listing events
 * and unparseable lines are ignored. Returns '' when the run produced no text.
 * @param {string} streamText - raw JSONL stdout
 * @returns {string}
 */
export function extractGrokFinalMessage(streamText) {
  let message = '';
  for (const line of String(streamText ?? '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'tool_call') message = '';
    else if (event?.type === 'text' && typeof event.data === 'string') message += event.data;
  }
  return message.trim();
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

/** Flat catalog id Grok Build lists beside a base when that base has a fast tier. */
export const GROK_BUILD_FAST_SUFFIX = '-build-fast';

const GROK_FAST_SETTING = /\[fast=(?:true|false)\]$/;

/**
 * Drop a trailing `[fast=true]` / `[fast=false]` setting. A generic `-fast`
 * suffix is a different model (`grok-code-fast-1`) and is left intact.
 * @param {unknown} model
 * @returns {string}
 */
export function stripGrokFastSetting(model) {
  return typeof model === 'string' ? model.replace(GROK_FAST_SETTING, '') : '';
}

/**
 * True when saved argv already names a model, including a baked fast setting
 * or a flat `-build-fast` id. Speed must not append a second `--model`.
 * @param {unknown} args
 * @returns {boolean}
 */
export function grokSpeedArgsConflict(args) {
  if (hasModelFlag(args)) return true;
  if (!Array.isArray(args)) return false;
  return args.some((arg) => typeof arg === 'string' && (arg.includes('[fast=') || arg.includes(GROK_BUILD_FAST_SUFFIX)));
}

/**
 * Pair a selected model with a `grok models` listing. Fast is available only
 * when that listing contains both the base id and `${base}-build-fast`. A
 * selected flat fast id maps back to the base only when the base is present.
 * The configured-default sentinel uses `defaultModelId` from that listing.
 * @param {string|null|undefined} model
 * @param {string[]} [catalogIds]
 * @param {string|null} [defaultModelId]
 * @returns {{ model: string|null, modelBase: string|null, values: string[], reason: string|null }}
 */
export function grokSpeedTarget(model, catalogIds = [], defaultModelId = null) {
  const ids = Array.isArray(catalogIds) ? catalogIds.filter((id) => typeof id === 'string' && id) : [];
  const explicit = model && model !== GROK_CONFIGURED_DEFAULT ? stripGrokFastSetting(model) : '';
  const selected = explicit || stripGrokFastSetting(defaultModelId || '');
  if (!selected) {
    return { model: null, modelBase: null, values: [], reason: 'Choose an explicit model before changing speed.' };
  }
  const siblingBase = selected.endsWith(GROK_BUILD_FAST_SUFFIX)
    ? selected.slice(0, -GROK_BUILD_FAST_SUFFIX.length)
    : '';
  const modelBase = siblingBase && ids.includes(siblingBase) ? siblingBase : selected;
  const fastId = `${modelBase}${GROK_BUILD_FAST_SUFFIX}`;
  if (!ids.includes(modelBase) || !ids.includes(fastId)) {
    return { model: selected, modelBase: null, values: [], reason: 'This model did not advertise a fast serving tier.' };
  }
  return { model: selected, modelBase, values: ['standard', 'fast'], reason: null };
}

/**
 * The `--model` value for an explicit speed, or null when the base cannot be
 * named. Null does not throw: the caller raises `executionOptionsError`.
 * `modelBase` is the catalog base recorded by capability inspection. Without
 * it, a flat `-build-fast` id is not guessed back to a base.
 * @param {string|null|undefined} model
 * @param {string|null|undefined} tier
 * @param {string|null|undefined} modelBase
 * @returns {string|null}
 */
export function grokServiceTierModel(model, tier, modelBase) {
  if (tier !== 'fast' && tier !== 'standard') return model || null;
  const confirmed = typeof modelBase === 'string' ? stripGrokFastSetting(modelBase) : '';
  const base = confirmed && confirmed !== GROK_CONFIGURED_DEFAULT
    ? confirmed
    : inferUnconfirmedGrokSpeedBase(model);
  if (!base || base === GROK_CONFIGURED_DEFAULT) return null;
  return `${base}[fast=${tier === 'fast' ? 'true' : 'false'}]`;
}

function inferUnconfirmedGrokSpeedBase(model) {
  const stripped = stripGrokFastSetting(model);
  if (!stripped || stripped === GROK_CONFIGURED_DEFAULT) return null;
  if (stripped.endsWith(GROK_BUILD_FAST_SUFFIX)) return null;
  return stripped;
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
 * `cleanup({ throwOnError: true })` lets an owner retain failed cleanup as a
 * recovery blocker; the default remains best-effort for existing callers.
 * @returns {{ args: string[], useStdin: boolean, cleanup: (options?: {throwOnError?: boolean}) => void }}
 */
export function prepareGrokPromptFile(args, prompt) {
  if (process.platform !== 'win32') return { args, useStdin: true, cleanup: NOOP_CLEANUP };
  // Locate the /dev/stdin sentinel in either form: separated
  // (`--prompt-file /dev/stdin`, what buildCliArgs emits) or joined
  // (`--prompt-file=/dev/stdin`, which a user could bake into provider.args and
  // which ensureGrokHeadlessArgs then leaves in place as an existing prompt
  // source). Both are a POSIX-only path grok can't open on Windows.
  const joined = `--prompt-file=${GROK_STDIN_PROMPT_PATH}`;
  const sepIdx = args.findIndex((a, i) => a === GROK_STDIN_PROMPT_PATH && args[i - 1] === '--prompt-file');
  const joinIdx = sepIdx === -1 ? args.indexOf(joined) : -1;
  if (sepIdx === -1 && joinIdx === -1) return { args, useStdin: true, cleanup: NOOP_CLEANUP };
  // A collision-resistant name — concurrent grok runs in the same process (e.g.
  // parallel CoS agents / pipeline stages) can reach here in the same millisecond,
  // so a pid+timestamp name would clobber each other's prompt or delete a file a
  // sibling still needs. randomUUID is unique per call (server-side Node crypto).
  const file = join(os.tmpdir(), `grok-prompt-${process.pid}-${randomUUID()}.txt`);
  writeFileSync(file, typeof prompt === 'string' ? prompt : '', 'utf8');
  const rewritten = [...args];
  if (sepIdx !== -1) rewritten[sepIdx] = file;
  else rewritten[joinIdx] = `--prompt-file=${file}`;
  return {
    args: rewritten,
    useStdin: false,
    cleanup: ({ throwOnError = false } = {}) => {
      try { unlinkSync(file); }
      catch (error) { if (throwOnError && error.code !== 'ENOENT') throw error; }
    },
  };
}
