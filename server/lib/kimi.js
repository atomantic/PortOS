/**
 * Per-CLI conventions for Moonshot AI's "Kimi Code" coding agent (binary: `kimi`).
 *
 * Kimi Code (MoonshotAI/kimi-cli, MIT-licensed) ships two PortOS process-provider
 * shapes (the plain HTTP API entry already exists separately as `nvidia-kimi`):
 *   - `kimi-cli`  (type `cli`) — headless one-shot via `kimi --print`.
 *   - `kimi-tui`  (type `tui`) — the interactive Kimi Code TUI driven over a PTY.
 *
 * Prompt delivery (headless): unlike claude/codex (raw stdin), `kimi --print`
 * takes the prompt as the VALUE of its `--prompt`/`-p` flag and does NOT read
 * stdin. `--print` also implicitly enables `--afk` (away-from-keyboard: auto-
 * approve tool calls, auto-dismiss AskUserQuestion), so a headless run never
 * stalls on an approval prompt. `prepareKimiPrompt` splices the prompt in as the
 * `--prompt` value and reports `useStdin: false`, mirroring the antigravity
 * `{ args, useStdin, cleanup }` shape so the shared `prepareCliPrompt` dispatcher
 * can handle it uniformly.
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
 * NOTE: `kimi` was not installed in the dev environment where this shipped, so the
 * argv-value prompt path (`--prompt <value>`, like `agy --print <value>`) was
 * chosen as the documented default and should be confirmed against a live binary.
 * Two follow-ups to reconcile once a live `kimi` is available (raised in review,
 * deferred because they can't be validated blind and both risk regressing the
 * happy path if guessed wrong):
 *   1. Argv length limits. A large CoS operating-contract prompt on the argv can
 *      exceed Windows' ~32K command-line limit (and eventually POSIX ARG_MAX). If
 *      the live `kimi --print` accepts the prompt from stdin (or from a
 *      `--prompt-file <path>` that can point at `/dev/stdin`, as grok does), switch
 *      this delivery to stdin to lift the cap. It is NOT switched now because the
 *      antigravity analog (`agy --print`) takes the prompt as an argv VALUE and
 *      does NOT read stdin at all — guessing stdin against an agy-like `kimi` would
 *      silently deliver an empty prompt, a worse failure than the length ceiling.
 *   2. Structured-output contamination. If plain `--print` interleaves intermediate
 *      tool/assistant activity with the final message, a pipeline stage that parses
 *      stdout as JSON could choke on the chatter. If the live `kimi` exposes a
 *      "final message only" flag, add it to `ensureKimiHeadlessArgs`. It is NOT
 *      added now because passing a flag the binary doesn't recognize would make
 *      every headless run fail at startup.
 */

import { commandBasename, hasModelFlag } from './providerModels.js';

const NOOP_CLEANUP = () => {};

// True when argv contains any of `flags`, in either separated (`--flag`) or
// joined (`--flag=value`) form. The generic scan behind the kimi arg builders.
const argvHasFlag = (args = [], flags) =>
  args.some((a) => typeof a === 'string' && flags.some((f) => a === f || a.startsWith(`${f}=`)));

export const KIMI_CLI_ID = 'kimi-cli';
export const KIMI_TUI_ID = 'kimi-tui';

// `--print` puts kimi in non-interactive print mode (implies `--afk`).
const PRINT_FLAGS = ['--print'];
// The prompt-carrying flags — kimi reads the prompt as this flag's VALUE.
const PROMPT_FLAGS = ['--prompt', '-p'];
// Auto-approval postures for the unattended PTY: `--yolo`/`-y` auto-approve all
// tool calls; `--afk` also auto-dismisses AskUserQuestion. Any one already
// present means the user pinned their own posture — don't add another.
const APPROVAL_FLAGS = ['--yolo', '-y', '--afk'];

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
 * Build the headless (one-shot) argv for the Kimi Code CLI. Ensures, when not
 * already pinned by the user's saved `args`:
 *   - `--print`      — non-interactive print mode (implies `--afk`, so tool calls
 *                      auto-approve; PortOS parses stdout as plain text).
 *   - `--model <id>` — gated on `model` being a real id (the sentinel already
 *                      resolved to null upstream) AND no user-baked model flag.
 * The prompt itself is NOT added here — it's spliced in as the `--prompt` value
 * at spawn time by `prepareKimiPrompt`.
 * @param {string[]} baseArgs - user/legacy args (already model-flag-sanitized)
 * @param {string|null|undefined} model - defaultModel to pin, or null to omit
 * @returns {string[]}
 */
export function ensureKimiHeadlessArgs(baseArgs = [], model) {
  const out = [...baseArgs];
  if (!argvHasFlag(out, PRINT_FLAGS)) {
    out.push('--print');
  }
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
 * VALUE of the `--prompt` flag (kimi does NOT read stdin in `--print` mode).
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
  // Find the LAST prompt flag so the value lands correctly even if a user baked
  // one into provider.args; otherwise append a fresh `--prompt <value>` pair.
  let idx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (PROMPT_FLAGS.includes(out[i])) { idx = i; break; }
  }
  if (idx === -1) {
    out.push('--prompt', typeof prompt === 'string' ? prompt : '');
  } else {
    out.splice(idx + 1, 0, typeof prompt === 'string' ? prompt : '');
  }
  return { args: out, useStdin: false, cleanup: NOOP_CLEANUP };
}
