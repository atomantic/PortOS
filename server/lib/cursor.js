/**
 * Per-CLI conventions for Cursor's agentic coding CLI (binary: `cursor-agent`).
 *
 * Headless `cursor-agent --print` reads the prompt from raw stdin (like claude/codex). Output is
 * PLAIN TEXT: `--output-format stream-json` emits text on frames `createStreamJsonParser` doesn't
 * extract. Untrusted workspaces make cursor-agent exit; `--force` clears that gate AND
 * auto-approves tools. There is no `--effort` flag (cursor exits non-zero on one): effort is a
 * model-id variant (`gpt-5[effort=max]`), so `buildEffortArgs` emits nothing and argv builders
 * fold it into `--model` via `foldCursorEffortIntoModel`; `auto` is a real model id.
 * Dependency-light so the standalone autofixer can import it.
 */

import { argvHasFlag, foldCursorEffortIntoModel, hasModelFlag } from './provider/providerModels.js';

export { CURSOR_COMMAND, isCursorCommand } from './aiToolkit/internal/cursor.js';

const PRINT_FLAGS = ['--print', '-p'];
// A headless run needs BOTH gates satisfied: TRUST (else it exits immediately) and APPROVAL
// (else it stalls on the first tool-call prompt until the provider timeout). The sets overlap
// but differ (`--trust` grants no approval, `--auto-review` doesn't clear trust), so check
// each independently.
const TRUST_FLAGS = ['--force', '-f', '--yolo', '--trust'];
const APPROVAL_FLAGS = ['--force', '-f', '--yolo', '--auto-review'];

/**
 * Add whatever posture flag the argv is still missing, honoring user-pinned ones.
 *
 * @param {string[]} out - argv, mutated in place
 * @returns {string[]} the same array, for chaining
 */
function ensureCursorPosture(out) {
  const hasTrust = argvHasFlag(out, TRUST_FLAGS);
  const hasApproval = argvHasFlag(out, APPROVAL_FLAGS);
  if (hasTrust && hasApproval) return out;
  // Narrow `--trust` only when the user already chose an approval posture we must not override.
  out.push(hasApproval ? '--trust' : '--force');
  return out;
}

/**
 * Build the headless argv (`--print`, posture flag, `--model` with folded `effort`), each unless
 * the user's saved args pin it. A user-baked `--model` also owns the effort. Prompt rides on stdin.
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
 * Ensure the interactive TUI argv clears the trust gate and auto-approves tools; idempotent.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
export function ensureCursorTuiArgs(args = []) {
  return ensureCursorPosture([...args]);
}
