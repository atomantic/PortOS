/**
 * Per-CLI conventions for Cursor's agentic coding CLI (binary: `cursor-agent`).
 *
 * Cursor ships two PortOS process-provider shapes:
 *   - `cursor-cli`  (type `cli`) — headless one-shot via `cursor-agent --print`.
 *   - `cursor-tui`  (type `tui`) — the interactive Cursor Agent TUI over a PTY.
 *
 * Prompt delivery (headless): `cursor-agent --print` reads the prompt from raw
 * stdin when no trailing prompt argument is given — the same convention as
 * claude/codex — so the shared `prepareCliPrompt` dispatcher needs no cursor
 * branch and the existing `stdin.write(prompt)` at every spawn site feeds it
 * unchanged. (Verified against cursor-agent 2026.08.04: `echo … | cursor-agent
 * -p --force` returns the reply on stdout and exits 0.)
 *
 * Workspace trust: cursor-agent refuses to run in a directory it has not been
 * told to trust, printing a "Workspace Trust Required" block and exiting instead
 * of doing any work — fatal for a headless agent, which has no one to answer it.
 * `--force` satisfies that gate (the binary's own message names `--trust`,
 * `--yolo`, or `-f`) AND auto-approves tool calls, so it is the single flag that
 * covers both, mirroring claude's `--dangerously-skip-permissions` / codex's
 * `--dangerously-bypass-approvals-and-sandbox` / kimi's `--yolo`.
 *
 * Output format: PortOS runs cursor in its default PLAIN TEXT mode, so the
 * live-output handler falls through to its default text path (like
 * grok/kimi/opencode). cursor-agent does offer `--output-format stream-json`
 * whose frames closely resemble Claude Code's, but its assistant text arrives on
 * `type: "assistant"` message frames rather than the `stream_event` /
 * `content_block_delta` frames `createStreamJsonParser` extracts live text from —
 * so selecting it today would yield a final result with no streaming output.
 * Teaching the parser that dialect is tracked separately.
 *
 * Model selection: unlike Grok/Kimi/Antigravity, cursor needs NO configured-
 * default sentinel — it exposes a real `auto` model id (its own server-side
 * router, and the binary's own default), so `auto` is stored as `defaultModel`
 * and passed through as a normal `--model auto`. Effort is baked into the model
 * ids themselves rather than exposed as a flag: there is no `--effort` (cursor
 * exits non-zero on one), and a level is instead a parameter of the model id in
 * Cursor's own variant syntax — `gpt-5[effort=max]`,
 * `claude-opus-4-7[thinking=true,effort=high]`. So cursor DOES advertise an
 * effort ladder (`effortLevelsForProvider` → `CURSOR_EFFORT_LEVELS`) while
 * `buildEffortArgs` emits nothing for it; every cursor argv builder folds the
 * level into `--model` via `foldCursorEffortIntoModel` instead. An effort with
 * no model to attach to is dropped — there is nothing to fold it into.
 *
 * Dependency-light on purpose: imports only `providerModels.js` helpers,
 * mirroring `grok.js`/`kimi.js`/`antigravity.js` so it stays importable from the
 * standalone autofixer.
 */

import { argvHasFlag, commandBasename, foldCursorEffortIntoModel, hasModelFlag } from './providerModels.js';

/** The binary basename. Deliberately NOT `cursor` — that is the GUI editor. */
export const CURSOR_COMMAND = 'cursor-agent';

/**
 * True when a provider command points at the Cursor Agent binary — the bare
 * `cursor-agent` on PATH, an absolute/relative path to it, or an optional
 * Windows `.exe` suffix (same matching rules as `isGrokCommand`/`isKimiCommand`).
 *
 * Matches ONLY `cursor-agent`, never a bare `cursor`: that is Cursor's GUI
 * editor launcher, and spawning it from a headless agent would open a window
 * (or hang) rather than run the coding agent.
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isCursorCommand(command) {
  return commandBasename(command) === CURSOR_COMMAND;
}

// `--print` (`-p`) puts cursor-agent in non-interactive print mode.
const PRINT_FLAGS = ['--print', '-p'];
// cursor-agent gates an unattended run on TWO orthogonal postures, and a headless
// run needs BOTH satisfied or it produces nothing:
//   - TRUST    — without it, cursor prints "Workspace Trust Required" and EXITS
//                immediately, before any work.
//   - APPROVAL — without it, the run reaches the first tool call and then stalls
//                on a permission prompt with nobody to answer, burning the whole
//                provider timeout.
// They overlap but are not the same set, so collapsing them into one list breaks
// in both directions: `--trust` clears trust but grants no approval, while
// `--auto-review` is an approval posture that does NOT clear trust. Treating
// either as "the user pinned a posture, we're done" suppresses the flag that
// covers the OTHER gate. Keep them separate and check each independently.
const TRUST_FLAGS = ['--force', '-f', '--yolo', '--trust'];
const APPROVAL_FLAGS = ['--force', '-f', '--yolo', '--auto-review'];

/**
 * Add whatever posture flag the argv is still missing, honoring anything the
 * user already pinned. `--force` satisfies both gates at once, so it is the
 * default; when the user pinned an approval posture we only owe them trust
 * (`--trust`), and vice-versa. No-op when both gates are already covered.
 * @param {string[]} out - argv, mutated in place
 * @returns {string[]} the same array, for chaining
 */
function ensureCursorPosture(out) {
  const hasTrust = argvHasFlag(out, TRUST_FLAGS);
  const hasApproval = argvHasFlag(out, APPROVAL_FLAGS);
  if (hasTrust && hasApproval) return out;
  // `--force` covers trust AND approval; only fall back to the narrow `--trust`
  // when the user has already chosen an approval posture we must not override.
  out.push(hasApproval ? '--trust' : '--force');
  return out;
}

/**
 * Build the headless (one-shot) argv for the Cursor Agent CLI. Ensures, when not
 * already pinned by the user's saved `args`:
 *   - `--print`      — non-interactive print mode (prompt read from stdin).
 *   - a posture flag — `--force` by default, which clears the workspace-trust
 *                      gate AND auto-approves tool calls, so an unattended run
 *                      neither exits on the trust block nor stalls on a prompt.
 *                      See `ensureCursorPosture` for how a user-pinned posture
 *                      narrows this to just the gate they left uncovered.
 *   - `--model <id>` — gated on `model` being set AND no user-baked model flag,
 *                      carrying `effort` as a folded model variant when pinned
 *                      (cursor has no `--effort` flag — see the file header).
 * The prompt itself is NOT added here — it rides on stdin at spawn time.
 * @param {string[]} baseArgs - user/legacy args (already model-flag-sanitized)
 * @param {string|null|undefined} model - defaultModel to pin, or null to omit
 * @param {string|null|undefined} [effort] - reasoning level to fold into the model id
 * @returns {string[]}
 */
export function ensureCursorHeadlessArgs(baseArgs = [], model, effort) {
  const out = [...baseArgs];
  if (!argvHasFlag(out, PRINT_FLAGS)) {
    out.push('--print');
  }
  ensureCursorPosture(out);
  const pinnedModel = foldCursorEffortIntoModel(model, effort);
  if (pinnedModel && !hasModelFlag(out)) {
    out.push('--model', pinnedModel);
  }
  return out;
}

/**
 * Ensure the interactive Cursor TUI argv clears the workspace-trust gate and
 * auto-approves tool executions, so a file-writing agent is neither refused at
 * startup nor stranded on an approval prompt (mirrors the codex
 * `--dangerously-bypass-approvals-and-sandbox` / claude-code-tui
 * `--dangerously-skip-permissions` / kimi `--yolo` TUI defaults). Idempotent
 * when the user already pinned a trust/approval posture.
 * @param {string[]} args
 * @returns {string[]}
 */
export function ensureCursorTuiArgs(args = []) {
  return ensureCursorPosture([...args]);
}
