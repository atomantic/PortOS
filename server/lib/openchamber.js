/**
  * Per-CLI conventions for OpenChamber's control CLI (binary `openchamber`): identity, `session create` headless argv, `provider/model` gate, and `--dir`/`--prompt` spawn-time delivery.
  *
  * OpenChamber (`@openchamber/web`) is an agentic dev environment built ON TOP of OpenCode, a different SHAPE of harness: **a control plane, not a one-shot binary** (`session create` posts to an already-running runtime whose port the CLI discovers; with none running the CLI errors clearly, and PortOS deliberately does NOT start it: it's a server the user owns with its own port, password and exposure); **CLI only, no TUI** (`modes: ['cli']`; bare `openchamber` starts the SERVER); **prompt and cwd are both argv** (`session create` requires `--dir <path>`, no cwd default since the runtime may not share the child's, and takes the prompt as the VALUE of `--prompt`; `prepareOpenchamberPrompt` supplies both at spawn time). Headless invocation: `openchamber session create --dir <path> --prompt <text> [--model <provider/model>] --wait --last-assistant --quiet`; `--wait` blocks until idle (default 600s, matching every PortOS harness timeout), `--last-assistant` appends the final assistant text, `--quiet` reduces stdout to session id plus that text (closest to `--print`). Dependency-light like `grok.js`/`kimi.js`/`cursor.js`/`pi.js`/`kilo.js`: imports only `providerModels.js` helpers so it stays importable from the standalone autofixer process.
 */

import { argvHasFlag, commandBasename, ensureLeadingSubcommand, hasModelFlag } from './providerModels.js';

export const OPENCHAMBER_COMMAND = 'openchamber';

/** The control action that runs a prompt: `openchamber session create`. */
const SESSION_CREATE = Object.freeze(['session', 'create']);

/** Flags making `session create` behave like every other headless harness: block until done and print the answer. */
const HEADLESS_FLAGS = Object.freeze(['--wait', '--last-assistant', '--quiet']);

const DIR_FLAGS = ['--dir', '--project'];

/**
 * True when a provider command points at the OpenChamber binary (bare, a path, or a Windows `.exe`; same rules as `isOpencodeCommand`). Compares the WHOLE basename so it never collides with OpenCode's matcher.
 */
export function isOpenchamberCommand(command) {
  return commandBasename(command) === OPENCHAMBER_COMMAND;
}

/**
 * True when a PROVIDER is OpenChamber-flavored: the shipped `openchamber-cli` id or any provider launching the binary.
 */
export function isOpenchamberProvider(provider) {
  return String(provider?.id || '').toLowerCase() === 'openchamber-cli'
    || isOpenchamberCommand(provider?.command);
}

/**
 * True for a model string OpenChamber accepts: the CLI requires `provider/model` (usage error otherwise), so a bare id is dropped, not passed through.
 */
export function isOpenchamberModelId(model) {
  if (typeof model !== 'string') return false;
  const slash = model.indexOf('/');
  return slash > 0 && slash < model.length - 1;
}

/**
 * Build the headless argv: the `session create` action and wait/print flags unless the saved args pin them, plus `--model <provider/model>` when a usable id is pinned and the user baked no model flag.
 * `--dir`/`--prompt` come from {@link prepareOpenchamberPrompt} at spawn time.
 */
export function ensureOpenchamberHeadlessArgs(baseArgs = [], model) {
  // `ensureLeadingSubcommand` keys on `session`, so a record pinned to `session send` keeps its deliberate subcommand.
  const out = ensureLeadingSubcommand(baseArgs, SESSION_CREATE);
  for (const flag of HEADLESS_FLAGS) {
    if (!argvHasFlag(out, [flag])) out.push(flag);
  }
  if (isOpenchamberModelId(model) && !hasModelFlag(out)) out.push('--model', model);
  return out;
}

/**
 * Spawn-time prompt delivery: splice in the working directory and the prompt, which the argv builder can't know. `--dir` is sent to OpenChamber's runtime rather than resolved locally, so a relative path or omitted flag does NOT fall back
 * to the child's cwd (it fails with `Missing required --dir or --project` or runs the agent wherever the runtime is); `cwd` is the directory PortOS hands `spawn()`, `process.cwd()` only for a call site spawning without one.
 * Both flags are skipped when the saved args carry them (a record pinned to `--project <id>` keeps its project). Mirrors `kimi.js#prepareKimiPrompt`'s `{ args, useStdin, cleanup }` shape for the shared `prepareCliPrompt` dispatcher.
 */
export function prepareOpenchamberPrompt(args = [], prompt = '', { cwd = null } = {}) {
  const out = [...args];
  if (!argvHasFlag(out, DIR_FLAGS)) out.push('--dir', cwd || process.cwd());
  if (!argvHasFlag(out, ['--prompt'])) out.push('--prompt', prompt);
  return { args: out, useStdin: false, cleanup: () => {} };
}
