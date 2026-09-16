/**
 * Per-CLI conventions for OpenChamber's control CLI (binary: `openchamber`).
 *
 * OpenChamber (`@openchamber/web`, MIT) is an agentic development environment
 * built ON TOP of OpenCode: a long-running workspace server with desktop, web,
 * VS Code and mobile surfaces. That makes it a different SHAPE of harness from
 * every other vendor here, and the differences are the whole content of this
 * file:
 *
 *   - **It is a control plane, not a one-shot binary.** `openchamber session
 *     create` posts an action to an already-running OpenChamber runtime (the
 *     CLI discovers its port) instead of doing the work in the child PortOS
 *     spawned. The user starts that runtime once (`openchamber`, or
 *     `openchamber startup enable`); an install with nothing running gets a
 *     clear CLI error, the same posture as a local-LLM provider whose daemon is
 *     down. PortOS deliberately does NOT start it — that is a server the user
 *     owns, with its own port, password and network exposure.
 *
 *   - **CLI only, no TUI.** OpenChamber's interactive surface is a web app, not
 *     a terminal UI, so there is nothing for a PTY to attach to and the harness
 *     registry declares `modes: ['cli']`. `openchamber` with no subcommand
 *     starts the SERVER, which is why no TUI argv builder exists here: emitting
 *     one would have PortOS launch a daemon in a PTY and call it an agent.
 *
 *   - **The prompt and the working directory are both argv.** `session create`
 *     requires `--dir <path>` (it has no cwd default — the directory is sent to
 *     the runtime, which may not share the child's) and takes the prompt as the
 *     VALUE of `--prompt`. Both are supplied by `prepareOpenchamberPrompt` at
 *     spawn time, which is the only point where the child's real cwd is known.
 *
 * The headless invocation, from OpenChamber's own `session` help:
 *
 *   openchamber session create --dir <path> --prompt <text> \
 *     [--model <provider/model>] --wait --last-assistant --quiet
 *
 * `--wait` blocks until the dispatched activity goes idle (default timeout 600
 * seconds, which is also every shipped PortOS harness timeout), `--last-assistant`
 * appends the final assistant text, and `--quiet` reduces stdout to the session
 * id followed by that text — the closest thing this CLI has to `--print`.
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
 * True when a provider command points at the OpenChamber binary — the bare
 * `openchamber` on PATH, an absolute/relative path to it, or an optional
 * Windows `.exe` suffix (same matching rules as `isOpencodeCommand`).
 *
 * Note it can never collide with OpenCode's own matcher despite the shared
 * prefix: both compare the WHOLE basename, not a prefix.
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isOpenchamberCommand(command) {
  return commandBasename(command) === OPENCHAMBER_COMMAND;
}

/**
 * True when a PROVIDER is OpenChamber-flavored — the shipped `openchamber-cli`
 * id or any provider whose launch command is the OpenChamber binary. The
 * provider-shaped companion to {@link isOpenchamberCommand}, matching the shape
 * of `isKimiProvider` / `isOpencodeProvider` in `providerModels.js`.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isOpenchamberProvider(provider) {
  return String(provider?.id || '').toLowerCase() === 'openchamber-cli'
    || isOpenchamberCommand(provider?.command);
}

/**
 * True for a model string OpenChamber will accept.
 *
 * `--model` is validated by the CLI as `provider/model` and a value failing
 * that exits with a usage error BEFORE any work — so a bare id (the shape most
 * other harnesses take) must be dropped rather than passed through, or pinning
 * a model would turn every run into an argv failure. Mirrors the CLI's own
 * check: one `/`, with something on each side.
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isOpenchamberModelId(model) {
  if (typeof model !== 'string') return false;
  const slash = model.indexOf('/');
  return slash > 0 && slash < model.length - 1;
}

/**
 * Build the headless argv for an OpenChamber run. Adds the `session create`
 * action and the wait/print flags unless the saved args already pin them, plus
 * `--model <provider/model>` when a usable model id is pinned and the user
 * baked no model flag of their own.
 *
 * Neither `--dir` nor `--prompt` is added here — both are spliced in by
 * {@link prepareOpenchamberPrompt} at spawn time, where the child's real
 * working directory is known.
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
