/**
 * Per-CLI conventions for Kilo Code's coding agent (binary: `kilo`).
 *
 * Kilo Code command identity (`kilo`/`kilocode`), `run` headless argv, `--auto` approval posture, and
 * TUI arguments.
 *
 * `@kilocode/cli` is a FORK of OpenCode with the same argv: `kilo-cli` runs headless via `kilo run`
 * (prompt on stdin) and `kilo-tui` is the interactive TUI. `--auto` makes unattended runs possible
 * (otherwise Kilo stops at the first permission prompt). **No `--agent` is injected**, unlike OpenCode's
 * `build`: Kilo's roster differs, so a hardcoded name could fail argv parsing; users pin one in saved
 * `args`. Dependency-light so it stays importable from the standalone autofixer process.
 */

import { argvHasFlag, commandBasename, ensureLeadingSubcommand, hasModelFlag } from './providerModels.js';

export const KILO_COMMAND = 'kilo';

/** `@kilocode/cli` installs two bin names for one program; published so the runtime registry aliases its install row instead of probing twice. */
export const KILO_COMMAND_ALIASES = Object.freeze(['kilocode']);

const KILO_COMMANDS = Object.freeze([KILO_COMMAND, ...KILO_COMMAND_ALIASES]);

const RUN_SUBCOMMAND = 'run';

// A user who already pinned `--auto` or `--no-auto` chose a posture PortOS must not override.
const APPROVAL_FLAGS = ['--auto', '--no-auto'];

/**
 * True when a provider command points at the Kilo binary (bare, path, or Windows `.exe`; same rules as `isOpencodeCommand`).
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isKiloCommand(command) {
  return KILO_COMMANDS.includes(commandBasename(command));
}

/**
 * True when a PROVIDER is Kilo-flavored: the shipped `kilo-cli`/`kilo-tui` ids or any provider launching the Kilo binary. Lives here so the binary spellings stay in ONE list.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isKiloProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'kilo-cli' || id === 'kilo-tui' || isKiloCommand(provider?.command);
}

/**
 * Add `--auto` unless the argv already pins an approval posture; shared by the headless and TUI builders.
 * @param {string[]} args
 * @returns {string[]}
 */
export function ensureKiloTuiArgs(args = []) {
  const out = [...args];
  if (!argvHasFlag(out, APPROVAL_FLAGS)) out.push('--auto');
  return out;
}

/**
 * Headless argv: `run`, approval posture, `--model <provider/model>` when pinned; a saved `run` is not duplicated. The prompt rides on stdin, not here.
 * @param {string[]} baseArgs - user/legacy args (already model-flag-sanitized)
 * @param {string|null|undefined} model - defaultModel to pin, or null to omit
 * @returns {string[]}
 */
export function ensureKiloHeadlessArgs(baseArgs = [], model) {
  const out = ensureKiloTuiArgs(ensureLeadingSubcommand(baseArgs, RUN_SUBCOMMAND));
  if (model && !hasModelFlag(out)) out.push('--model', model);
  return out;
}
