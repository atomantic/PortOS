/**
 * Hermes Agent (NousResearch/hermes-agent, binary: `hermes`) argv conventions.
 *
 * Verified against the published CLI reference (`hermes chat`, global options):
 *   - Headless: `hermes chat --oneshot --quiet --query-file -` answers one prompt and exits;
 *     `--query-file -` reads the prompt from stdin verbatim (nothing is shell-interpreted), so a
 *     large PortOS prompt never rides argv. `--quiet` keeps stdout to the final answer.
 *   - Unattended runs carry `--yolo` (skip dangerous-command approval prompts); tool-free callers
 *     strip it (providerVendors.js `APPROVAL_BYPASS_FLAGS`).
 *   - Interactive: `hermes --tui` (global flag); `--model` / `--provider` are accepted at the top level.
 *   - There is NO per-run reasoning-effort flag (effort is `agent.reasoning_effort` in the user's
 *     config.yaml), so PortOS passes none and `effortLevelsForProvider` reports no ladder.
 *   - There is NO switch that disables every tool (`--toolsets` only enables sets), so a Hermes
 *     one-shot is never tool-free: `toolFreeOneShotRefusal` applies it as host control.
 *
 * Dependency-light (only `providerModels.js` helpers) so it stays importable from the standalone autofixer.
 */
import { argvHasFlag, commandBasename, ensureLeadingSubcommand, hasModelFlag } from './provider/providerModels.js';

export const HERMES_COMMAND = 'hermes';
export const isHermesCommand = (command) => commandBasename(command) === HERMES_COMMAND;

const APPROVAL_FLAGS = ['--yolo'];
const QUERY_FILE_FLAGS = ['--query-file'];
const NOOP_CLEANUP = () => {};

/** TUI argv: `--tui`, plus the approval bypass an unattended PTY needs unless the user pinned a posture. */
export function ensureHermesTuiArgs(baseArgs = []) {
  const args = [...baseArgs];
  if (!argvHasFlag(args, ['--tui', '--cli'])) args.unshift('--tui');
  if (!argvHasFlag(args, APPROVAL_FLAGS)) args.push('--yolo');
  return args;
}

/** Headless argv; `prepareHermesPrompt` appends the stdin query file last. */
export function ensureHermesHeadlessArgs(baseArgs = [], model) {
  const args = ensureLeadingSubcommand(baseArgs, 'chat');
  if (!argvHasFlag(args, ['--oneshot'])) args.push('--oneshot');
  if (!argvHasFlag(args, ['--quiet', '-Q'])) args.push('--quiet');
  if (!argvHasFlag(args, APPROVAL_FLAGS)) args.push('--yolo');
  if (model && !hasModelFlag(args)) args.push('--model', model);
  return args;
}

/** Deliver the prompt over stdin through `--query-file -`, replacing any baked query source. */
export function prepareHermesPrompt(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (QUERY_FILE_FLAGS.includes(arg)) { i += 1; continue; }
    if (QUERY_FILE_FLAGS.some((flag) => typeof arg === 'string' && arg.startsWith(`${flag}=`))) continue;
    out.push(arg);
  }
  return { args: [...out, '--query-file', '-'], useStdin: true, cleanup: NOOP_CLEANUP };
}
