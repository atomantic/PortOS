/**
 * Per-CLI conventions for Kilo Code's coding agent (binary: `kilo`).
 *
 * Kilo CLI (`@kilocode/cli`, MIT) is a FORK of OpenCode, and its argv is
 * OpenCode's with one addition, so PortOS drives it the same way:
 *   - `kilo-cli` (type `cli`) — headless one-shot via `kilo run`, prompt on stdin.
 *   - `kilo-tui` (type `tui`) — the interactive Kilo TUI over a PTY.
 *
 * Flags this file relies on, taken verbatim from Kilo's own CLI reference —
 * both the `run` subcommand and the bare (TUI) entry point accept all three:
 *   - `-m, --model   model to use in the format of provider/model  [string]`
 *   - `--agent       agent to use  [string]`
 *   - `--auto        auto-approve permissions that are not explicitly denied`
 *
 * `--auto` is the piece that makes an unattended run possible at all: without
 * it Kilo stops at the first permission prompt with nobody to answer, burning
 * the whole provider timeout. It is the same posture claude's
 * `--dangerously-skip-permissions` / codex's
 * `--dangerously-bypass-approvals-and-sandbox` / kimi's `--yolo` supply, and —
 * unlike OpenCode, whose permissions live only in its config — Kilo exposes it
 * as an argv flag on BOTH the headless and interactive entry points.
 *
 * **No `--agent` is injected**, deliberately, and this is where Kilo and
 * OpenCode part company: PortOS pins OpenCode's `build` agent because a bare
 * `opencode run` opens in whatever agent that install defaults to (#7405). Kilo
 * ships a different agent roster (Architect / Ask / Debug / Orchestrator / …),
 * so a hardcoded `build` would name an agent the binary may not have and fail
 * the run at argv parsing. A user who wants one pins it in the provider's saved
 * `args`, and `argvHasFlag` keeps that pin.
 *
 * Model ids are Kilo's `provider/model` form, which is exactly what `--model`
 * takes — no namespacing adapter is involved (that is an OpenCode-config
 * concern PortOS does not write for Kilo; see `providerHarnesses.js` on why
 * Kilo carries no mintable route recipe).
 *
 * Dependency-light on purpose: imports only `providerModels.js` helpers,
 * mirroring `grok.js`/`kimi.js`/`cursor.js`/`pi.js` so it stays importable from
 * the standalone autofixer process.
 */

import { argvHasFlag, commandBasename, ensureLeadingSubcommand, hasModelFlag } from './providerModels.js';

/** The canonical binary basename. */
export const KILO_COMMAND = 'kilo';

/**
 * `@kilocode/cli` installs TWO bin names for one program (`kilo` and
 * `kilocode`), so a provider configured with either spelling is the same
 * harness. Published so the runtime registry can alias its install row rather
 * than probing the same binary twice.
 */
export const KILO_COMMAND_ALIASES = Object.freeze(['kilocode']);

const KILO_COMMANDS = Object.freeze([KILO_COMMAND, ...KILO_COMMAND_ALIASES]);

/** The headless subcommand — `kilo run [message..]`, prompt read from stdin. */
const RUN_SUBCOMMAND = 'run';

/**
 * Auto-approval postures. `--auto` is Kilo's own spelling; a user who already
 * pinned it (or its `--no-auto` opposite) has chosen a posture PortOS must not
 * override.
 */
const APPROVAL_FLAGS = ['--auto', '--no-auto'];

/**
 * True when a provider command points at the Kilo binary — the bare `kilo` /
 * `kilocode` on PATH, an absolute/relative path to either, or an optional
 * Windows `.exe` suffix (same matching rules as `isOpencodeCommand`).
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isKiloCommand(command) {
  return KILO_COMMANDS.includes(commandBasename(command));
}

/**
 * True when a PROVIDER is Kilo-flavored — the shipped `kilo-cli`/`kilo-tui`
 * ids or any provider whose launch command is the Kilo binary. The
 * provider-shaped companion to {@link isKiloCommand}, matching the shape of
 * `isKimiProvider` / `isOpencodeProvider` in `providerModels.js`; it lives here
 * rather than there so the accepted binary spellings stay in ONE list.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isKiloProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'kilo-cli' || id === 'kilo-tui' || isKiloCommand(provider?.command);
}

/**
 * Add `--auto` unless the argv already pins an approval posture. Shared by the
 * headless and TUI builders so the two cannot drift.
 * @param {string[]} args
 * @returns {string[]}
 */
export function ensureKiloTuiArgs(args = []) {
  const out = [...args];
  if (!argvHasFlag(out, APPROVAL_FLAGS)) out.push('--auto');
  return out;
}

/**
 * Build the headless (one-shot) argv for the Kilo CLI: `run`, the approval
 * posture, and `--model <provider/model>` when a model is pinned and the user
 * baked no model flag of their own.
 *
 * A leading `run` already present in the saved args is detected rather than
 * duplicated (the same guard `opencodeCliArgs` applies), so a legacy record
 * that pinned the subcommand does not end up as `kilo run run`.
 *
 * The prompt itself is NOT added here — it rides on stdin at spawn time.
 * @param {string[]} baseArgs - user/legacy args (already model-flag-sanitized)
 * @param {string|null|undefined} model - defaultModel to pin, or null to omit
 * @returns {string[]}
 */
export function ensureKiloHeadlessArgs(baseArgs = [], model) {
  const out = ensureKiloTuiArgs(ensureLeadingSubcommand(baseArgs, RUN_SUBCOMMAND));
  if (model && !hasModelFlag(out)) out.push('--model', model);
  return out;
}
