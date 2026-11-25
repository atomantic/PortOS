/**
 * Per-CLI conventions for Moonshot AI's "Kimi Code" coding agent (binary: `kimi`).
 *
 * Kimi Code (MoonshotAI/kimi-cli) ships two PortOS process-provider shapes,
 * distinct from the hosted NVIDIA NIM API gateway:
 *   - `kimi-cli`  (type `cli`) — headless one-shot via `kimi --prompt <value>`.
 *   - `kimi-tui`  (type `tui`) — the interactive Kimi Code TUI driven over a PTY.
 *
 * Verified against a live `kimi` v0.32.0:
 *   - There is NO `--print` or `--afk` flag (argv-parse errors). Non-interactive
 *     mode is implicit in supplying `-p`/`--prompt`.
 *   - The headless path takes NO approval flag: kimi refuses `--prompt` combined
 *     with `--yolo`/`-y`/`--auto` and runs unattended without one. Only the
 *     interactive TUI path (no `--prompt`) gets `--yolo`.
 *
 * Prompt delivery (headless): `kimi` takes the prompt as the VALUE of
 * `--prompt`/`-p` and does NOT read stdin, so `prepareKimiPrompt` reports
 * `useStdin: false`; a large CoS prompt can exceed Windows' ~32K argv limit.
 *
 * Model selection mirrors Antigravity/Grok Build: the stored sentinel
 * (`KIMI_CONFIGURED_DEFAULT`) resolves to null via `resolveCliModel`, so spawns
 * omit `--model` and `kimi` uses its own default; a pinned real id gets `--model`.
 *
 * Dependency-light (only `providerModels.js` helpers) so it stays importable
 * from the standalone autofixer.
 */

import { argvHasFlag, commandBasename, hasModelFlag } from './provider/providerModels.js';

const NOOP_CLEANUP = () => {};

// A `-`-leading token after a bare trailing `--prompt` is ambiguous on any CLI,
// so it is treated as a flag rather than the existing prompt value.
const isFlagToken = (a) => typeof a === 'string' && a.startsWith('-');

// kimi reads the prompt as this flag's VALUE; its presence selects non-interactive mode.
const PROMPT_FLAGS = ['--prompt', '-p'];
// Auto-approval for the unattended PTY; already present means the user pinned a
// posture. Interactive path ONLY: kimi rejects these alongside `--prompt`.
const APPROVAL_FLAGS = ['--yolo', '-y'];

/**
 * True when a provider command points at the Kimi Code binary (bare, path, or Windows `.exe`; same rules as `isGrokCommand`).
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isKimiCommand(command) {
  return commandBasename(command) === 'kimi';
}

/**
 * Headless argv: the ONLY addition is `--model <id>`, gated on a real id AND no
 * user-baked model flag. No mode or approval flag is added (kimi exits at argv
 * parsing on either); the prompt is spliced in by `prepareKimiPrompt`.
 * @param {string[]} baseArgs - user/legacy args (already model-flag-sanitized)
 * @param {string|null|undefined} model - defaultModel to pin, or null to omit
 * @returns {string[]}
 */
export function ensureKimiHeadlessArgs(baseArgs = [], model) {
  const out = [...baseArgs];
  if (model && !hasModelFlag(out)) {
    out.push('--model', model);
  }
  return out;
}

/**
 * Ensure the interactive Kimi TUI argv auto-approves tool executions so an agent
 * isn't stranded on an approval prompt; idempotent when the user pinned a
 * posture. Interactive path only — the headless (`--prompt`) path must never get one.
 * @param {string[]} args
 * @returns {string[]}
 */
export function ensureKimiTuiArgs(args = []) {
  const out = [...args];
  if (!argvHasFlag(out, APPROVAL_FLAGS)) {
    out.push('--yolo');
  }
  return out;
}

/**
 * Spawn-time prompt delivery: splice the prompt in as the VALUE of `--prompt`
 * (kimi does NOT read stdin). Mirrors the `{ args, useStdin, cleanup }` shape of
 * `prepareAntigravityPrompt` so `prepareCliPrompt` can dispatch uniformly.
 * @param {string[]} args - argv as built by ensureKimiHeadlessArgs
 * @param {string} prompt - the full prompt text
 * @returns {{ args: string[], useStdin: false, cleanup: () => void }}
 */
export function prepareKimiPrompt(args = [], prompt = '') {
  const out = [...args];
  const value = typeof prompt === 'string' ? prompt : '';
  // Replace the LAST prompt flag's value so a user-baked one can't leave a stray second positional
  // (`['--prompt','old']` + splice would yield `['--prompt', value, 'old']`). Handles both the
  // separated (`--prompt <v>`) and joined (`--prompt=<v>`) forms; absent → append a fresh pair.
  let sepIdx = -1;   // index of a separated flag token (`--prompt`); its value is out[idx+1]
  let joinIdx = -1;  // index of a joined `--prompt=…` token
  for (let i = out.length - 1; i >= 0; i--) {
    const a = out[i];
    if (typeof a !== 'string') continue;
    if (PROMPT_FLAGS.includes(a)) { sepIdx = i; break; }
    if (PROMPT_FLAGS.some((f) => a.startsWith(`${f}=`))) { joinIdx = i; break; }
  }
  if (joinIdx !== -1) {
    const flag = out[joinIdx].slice(0, out[joinIdx].indexOf('='));
    out[joinIdx] = `${flag}=${value}`;
  } else if (sepIdx === -1) {
    out.push('--prompt', value);
  } else if (sepIdx + 1 < out.length && !isFlagToken(out[sepIdx + 1])) {
    out[sepIdx + 1] = value;
  } else {
    out.splice(sepIdx + 1, 0, value);
  }
  return { args: out, useStdin: false, cleanup: NOOP_CLEANUP };
}
