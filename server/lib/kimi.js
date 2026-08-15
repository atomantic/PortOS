/**
 * Per-CLI conventions for Moonshot AI's "Kimi Code" coding agent (binary: `kimi`).
 *
 * Kimi Code (MoonshotAI/kimi-cli, MIT-licensed) ships two PortOS process-provider
 * shapes (the plain HTTP API entry already exists separately as `nvidia-kimi`):
 *   - `kimi-cli`  (type `cli`) — headless one-shot via `kimi --prompt <value>`.
 *   - `kimi-tui`  (type `tui`) — the interactive Kimi Code TUI driven over a PTY.
 *
 * Verified against a live `kimi` v0.32.0 (issue #4139 — the shape below was first
 * written blind against docs, and every headless run failed at argv parsing):
 *   - There is NO `--print` flag (`error: unknown option '--print'`). Non-interactive
 *     mode is implicit in supplying `-p`/`--prompt`, so the headless argv needs no
 *     mode flag at all beyond the prompt itself.
 *   - There is NO `--afk` flag either (`error: unknown option '--afk'`).
 *   - The headless path takes NO approval-posture flag: kimi refuses to combine
 *     `--prompt` with `--yolo`/`-y`/`--auto` (`error: Cannot combine --prompt with
 *     --yolo.`) and runs unattended without one. Only the interactive TUI path
 *     (no `--prompt`) gets `--yolo`.
 *
 * Prompt delivery (headless): unlike claude/codex (raw stdin), `kimi` takes the
 * prompt as the VALUE of its `--prompt`/`-p` flag and does NOT read stdin (neither
 * a stdin path nor a `--prompt-file` option appears in `--help`).
 * `prepareKimiPrompt` splices the prompt in as the `--prompt` value and reports
 * `useStdin: false`, mirroring the antigravity `{ args, useStdin, cleanup }` shape
 * so the shared `prepareCliPrompt` dispatcher can handle it uniformly.
 *
 * Model selection mirrors Antigravity/Grok Build: PortOS does not pick a model.
 * The stored sentinel lives in providerModels.js (`KIMI_CONFIGURED_DEFAULT`);
 * spawn paths omit `--model` (the sentinel resolves to null via `resolveCliModel`)
 * so the local `kimi` binary uses its own configured default (settable via
 * `/model`). A user who pins a real model id gets `--model <id>` injected.
 *
 * Dependency-light on purpose: imports only `providerModels.js` helpers, mirroring
 * `grok.js`/`antigravity.js` so it stays importable from the standalone autofixer.
 *
 * Known remaining limitation (confirmed, not a guess): argv length. A large CoS
 * operating-contract prompt rides the command line and can exceed Windows' ~32K
 * limit (and eventually POSIX `ARG_MAX`). There is no lower-risk delivery to switch
 * to — `-p <value>` is the only prompt mechanism `kimi --help` documents.
 *
 * Deliberately not adopted: `--output-format stream-json` (`--output-format` takes
 * `text` (default) or `stream-json`). It would let a pipeline stage parse discrete
 * JSON events instead of scraping possibly-interleaved plain text, but no stage
 * parses kimi's stdout programmatically today, so `text` stays the default.
 */

import { argvHasFlag, commandBasename, hasModelFlag } from './providerModels.js';

const NOOP_CLEANUP = () => {};

// True when a token looks like an option flag (leading `-`), so a prompt VALUE is
// never mistaken for one when deciding whether a separated `--prompt` already
// carries a value. A prompt beginning with `-` after a bare trailing `--prompt` is
// ambiguous on any CLI, so treating a `-`-leading token as a flag here is correct.
const isFlagToken = (a) => typeof a === 'string' && a.startsWith('-');

export const KIMI_CLI_ID = 'kimi-cli';
export const KIMI_TUI_ID = 'kimi-tui';

// The prompt-carrying flags — kimi reads the prompt as this flag's VALUE, and
// their mere presence is what puts kimi in non-interactive mode (there is no
// separate `--print`-style boolean; see the header note).
const PROMPT_FLAGS = ['--prompt', '-p'];
// Auto-approval postures for the unattended PTY: `--yolo`/`-y` auto-approve all
// tool calls. Either one already present means the user pinned their own posture
// — don't add another. Interactive path ONLY: kimi rejects these alongside
// `--prompt` (`Cannot combine --prompt with --yolo.`).
const APPROVAL_FLAGS = ['--yolo', '-y'];

/**
 * True when a provider command points at the Kimi Code binary — the bare `kimi`
 * on PATH, an absolute/relative path to it, or an optional Windows `.exe` suffix
 * (same matching rules as `isGrokCommand`/`isOpencodeCommand`).
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isKimiCommand(command) {
  return commandBasename(command) === 'kimi';
}

/** True for the CLI (headless) Kimi provider. */
export function isKimiCliProvider(provider) {
  return provider?.id === KIMI_CLI_ID
    || (provider?.type === 'cli' && isKimiCommand(provider?.command));
}

/** True for the TUI (interactive) Kimi provider. */
export function isKimiTuiProvider(provider) {
  return provider?.id === KIMI_TUI_ID
    || (provider?.type === 'tui' && isKimiCommand(provider?.command));
}

/**
 * Build the headless (one-shot) argv for the Kimi Code CLI. The ONLY thing added
 * here is `--model <id>`, gated on `model` being a real id (the sentinel already
 * resolved to null upstream) AND no user-baked model flag.
 *
 * No mode flag and no approval flag are added — kimi has neither a `--print`
 * boolean (non-interactive mode is implicit in `--prompt`) nor a headless
 * approval posture (it refuses `--yolo`/`-y`/`--auto` alongside `--prompt`).
 * Adding any of them makes the binary exit at argv parsing before it runs.
 *
 * The prompt itself is NOT added here — it's spliced in as the `--prompt` value
 * at spawn time by `prepareKimiPrompt`.
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
 * Ensure the interactive Kimi TUI argv auto-approves tool executions so a
 * file-writing agent isn't stranded on an approval prompt (mirrors the codex
 * `--dangerously-bypass-approvals-and-sandbox` / claude-code-tui
 * `--dangerously-skip-permissions` / grok `--permission-mode bypassPermissions`
 * TUI defaults). Idempotent when the user already pinned an approval posture.
 * Interactive path only — the headless (`--prompt`) path must never get one.
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
 * Spawn-time prompt delivery for the Kimi Code CLI: splice the prompt in as the
 * VALUE of the `--prompt` flag (kimi does NOT read stdin). Supplying the flag is
 * also what selects non-interactive mode — there is no separate mode flag.
 * Mirrors the `{ args, useStdin, cleanup }` shape of
 * `antigravity.js#prepareAntigravityPrompt` / `grok.js#prepareGrokPromptFile` so
 * the spawn sites can dispatch through the single `prepareCliPrompt` helper.
 *
 * @param {string[]} args - argv as built by ensureKimiHeadlessArgs
 * @param {string} prompt - the full prompt text
 * @returns {{ args: string[], useStdin: false, cleanup: () => void }}
 */
export function prepareKimiPrompt(args = [], prompt = '') {
  const out = [...args];
  const value = typeof prompt === 'string' ? prompt : '';
  // Find the LAST prompt flag so the value lands correctly even if a user baked one
  // into provider.args — in BOTH forms: separated (`--prompt`/`-p`, value is the
  // next token) and joined (`--prompt=<value>`). A separated flag that already has a
  // value must be REPLACED, not inserted ahead of — `splice(idx+1, 0, value)` on
  // `['--prompt','old']` yields `['--prompt', value, 'old']`, leaving `old` as a
  // stray positional kimi would treat as a second prompt. Absent → append a fresh pair.
  let sepIdx = -1;   // index of a separated flag token (`--prompt`); its value is out[idx+1]
  let joinIdx = -1;  // index of a joined `--prompt=…` token
  for (let i = out.length - 1; i >= 0; i--) {
    const a = out[i];
    if (typeof a !== 'string') continue;
    if (PROMPT_FLAGS.includes(a)) { sepIdx = i; break; }
    if (PROMPT_FLAGS.some((f) => a.startsWith(`${f}=`))) { joinIdx = i; break; }
  }
  if (joinIdx !== -1) {
    // Replace the joined token's value: `--prompt=old` → `--prompt=<value>`.
    const flag = out[joinIdx].slice(0, out[joinIdx].indexOf('='));
    out[joinIdx] = `${flag}=${value}`;
  } else if (sepIdx === -1) {
    out.push('--prompt', value);
  } else if (sepIdx + 1 < out.length && !isFlagToken(out[sepIdx + 1])) {
    // The separated flag already carries a value — replace it in place.
    out[sepIdx + 1] = value;
  } else {
    // Flag is last, or immediately followed by another flag — insert the value.
    out.splice(sepIdx + 1, 0, value);
  }
  return { args: out, useStdin: false, cleanup: NOOP_CLEANUP };
}
