/**
 * Per-CLI conventions for OpenChamber's control CLI (binary: `openchamber`).
 *
 * OpenChamber control-CLI identity, `session create` headless argv, `provider/model` gate, and
 * `--dir`/`--prompt` spawn-time delivery.
 *
 * OpenChamber (`@openchamber/web`) is an agentic dev environment built ON TOP of OpenCode, a
 * different SHAPE of harness from every other vendor here:
 *
 *   - **A control plane, not a one-shot binary.** `openchamber session create` posts to an
 *     already-running OpenChamber runtime (the CLI discovers its port). The user starts that runtime
 *     once; with nothing running the CLI errors clearly, like a local-LLM provider whose daemon is
 *     down. PortOS deliberately does NOT start it: it is a server the user owns, with its own port,
 *     password and network exposure.
 *   - **CLI only, no TUI.** The interactive surface is a web app, so the harness registry declares
 *     `modes: ['cli']`; bare `openchamber` starts the SERVER, so no TUI argv builder exists.
 *   - **Prompt and working directory are both argv.** `session create` requires `--dir <path>` (no
 *     cwd default; the runtime may not share the child's) and takes the prompt as the VALUE of
 *     `--prompt`. `prepareOpenchamberPrompt` supplies both at spawn time, when the real cwd is known.
 *
 * Headless invocation:
 *
 *   openchamber session create --dir <path> --prompt <text> \
 *     [--model <provider/model>] --wait --last-assistant --quiet
 *
 * `--wait` blocks until idle (default timeout 600s, matching every shipped PortOS harness timeout),
 * `--last-assistant` appends the final assistant text, `--quiet` reduces stdout to the session id
 * plus that text: the closest thing to `--print`.
 *
 * Dependency-light on purpose: imports only `providerModels.js` helpers,
 * mirroring `grok.js`/`kimi.js`/`cursor.js`/`pi.js`/`kilo.js` so it stays
 * importable from the standalone autofixer process.
 */

import { argvHasFlag, commandBasename, ensureLeadingSubcommand, hasModelFlag } from './providerModels.js';

/** The binary basename. */
export const OPENCHAMBER_COMMAND = 'openchamber';

/** The control action that runs a prompt: `openchamber session create`. */
const SESSION_CREATE = Object.freeze(['session', 'create']);

/**
 * Flags that make `session create` behave like every other headless harness:
 * block until the work is done, and print the model's answer.
 */
const HEADLESS_FLAGS = Object.freeze(['--wait', '--last-assistant', '--quiet']);

/** The two spellings that address a session's working directory. */
const DIR_FLAGS = ['--dir', '--project'];

/**
 * True when a provider command points at the OpenChamber binary (bare, a path, or a Windows `.exe`;
 * same rules as `isOpencodeCommand`). Compares the WHOLE basename, so it never collides with
 * OpenCode's matcher.
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isOpenchamberCommand(command) {
  return commandBasename(command) === OPENCHAMBER_COMMAND;
}

/**
 * True when a PROVIDER is OpenChamber-flavored: the shipped `openchamber-cli` id or any provider
 * launching the OpenChamber binary.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isOpenchamberProvider(provider) {
  return String(provider?.id || '').toLowerCase() === 'openchamber-cli'
    || isOpenchamberCommand(provider?.command);
}

/**
 * True for a model string OpenChamber will accept: the CLI requires `provider/model` and exits with
 * a usage error otherwise, so a bare id must be dropped, not passed through.
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isOpenchamberModelId(model) {
  if (typeof model !== 'string') return false;
  const slash = model.indexOf('/');
  return slash > 0 && slash < model.length - 1;
}

/**
 * Build the headless argv: the `session create` action and wait/print flags unless the saved args
 * pin them, plus `--model <provider/model>` when a usable id is pinned and the user baked no model
 * flag. `--dir` and `--prompt` come from {@link prepareOpenchamberPrompt} at spawn time.
 *
 * @param {string[]} baseArgs - user/legacy args (already model-flag-sanitized)
 * @param {string|null|undefined} model - defaultModel to pin, or null to omit
 * @returns {string[]}
 */
export function ensureOpenchamberHeadlessArgs(baseArgs = [], model) {
  // `ensureLeadingSubcommand` keys on `session`, so a record pinned to
  // `session send` keeps the subcommand the user chose deliberately.
  const out = ensureLeadingSubcommand(baseArgs, SESSION_CREATE);
  for (const flag of HEADLESS_FLAGS) {
    if (!argvHasFlag(out, [flag])) out.push(flag);
  }
  if (isOpenchamberModelId(model) && !hasModelFlag(out)) out.push('--model', model);
  return out;
}

/**
 * Spawn-time prompt delivery: splice in the working directory and the prompt,
 * neither of which the argv builder can know.
 *
 * `--dir` is the directory the session runs in. OpenChamber sends it to its
 * runtime rather than resolving it locally, so a relative path or an omitted
 * flag does NOT fall back to the child's cwd — it fails (`Missing required
 * --dir or --project`) or, worse, runs the agent wherever the runtime happens
 * to be. `cwd` is therefore the directory PortOS is about to hand `spawn()`,
 * and `process.cwd()` only when a call site genuinely spawns without one.
 *
 * Both flags are skipped when the saved args already carry them, so a record
 * pinned to `--project <id>` keeps addressing its project.
 *
 * Mirrors the `{ args, useStdin, cleanup }` shape of
 * `kimi.js#prepareKimiPrompt` so the shared `prepareCliPrompt` dispatcher can
 * handle it uniformly.
 *
 * @param {string[]} args - argv as built by ensureOpenchamberHeadlessArgs
 * @param {string} prompt - the full prompt text
 * @param {{cwd?: string|null}} [options] - the cwd the child will be spawned in
 * @returns {{ args: string[], useStdin: false, cleanup: () => void }}
 */
export function prepareOpenchamberPrompt(args = [], prompt = '', { cwd = null } = {}) {
  const out = [...args];
  if (!argvHasFlag(out, DIR_FLAGS)) out.push('--dir', cwd || process.cwd());
  if (!argvHasFlag(out, ['--prompt'])) out.push('--prompt', prompt);
  return { args: out, useStdin: false, cleanup: () => {} };
}
