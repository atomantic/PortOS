/**
 * Task Prompt Service
 *
 * Prompt-resolution logic for scheduled improvement tasks. Split out of
 * taskSchedule.js (issue #744) so the prompt getters live separate from the
 * schedule/interval orchestration that consumes them. The default prompt
 * catalog and the distribution-model compatibility constants live one level
 * down in taskPromptDefaults.js (issue #1083) — a pure data leaf with no
 * task-graph imports.
 *
 * Import graph (issue #1083 — no cycles):
 *   taskPromptDefaults.js  (data leaf, imports only PORTOS_API_URL)
 *     ↑ static            ↑ static
 *   taskPromptService.js   taskScheduleStore.js
 *     │                    ↑ static
 *     └──── static ─── taskSchedule.js
 *       (this module imports getTaskInterval from the compatibility facade)
 *
 * The prior split papered over a static circular import (taskSchedule ⇄
 * taskPromptService) with a lazy `await import('./taskSchedule.js')` inside
 * getTaskInterval. Moving the data to the leaf removes taskSchedule's need to
 * import this module, so this module can import getTaskInterval statically and
 * the lazy hack is gone.
 *
 * This module re-exports the data constants (DEFAULT_TASK_PROMPTS,
 * PROMPT_VERSIONS, PREVIOUS_DEFAULT_PROMPTS, REFERENCE_WATCH_AUDITED_VERSION)
 * so existing importers of taskPromptService are unaffected by the leaf split.
 */

import { PATHS } from '../lib/fileUtils.js';
import { loadSlashdoFile, loadSlashdoLib } from '../lib/slashdoLoader.js';
import { getTaskInterval } from './taskSchedule.js';
import {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS,
  promptMatchesShippedDefault
} from './taskPromptDefaults.js';

// Re-export the prompt data/compat constants so existing importers of this
// module keep working unchanged after the leaf split.
export {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS
};

// The scheduled plan-task default intentionally omits the review loop, but the
// manual /do:next PLAN claim still owns the complete claim lifecycle. Keep that
// path on the last shipped review-capable body rather than silently handing it
// a partial prompt just because both paths resolve the same task type.
const CLAIM_FLOW_DEFAULT_PROMPTS = Object.freeze({
  'plan-task': PREVIOUS_DEFAULT_PROMPTS['plan-task'].at(-1)
});

// ============================================================
// Prompt getters
// ============================================================

export function getDefaultPrompt(taskType) {
  return DEFAULT_TASK_PROMPTS[taskType] || null;
}

// Cache slashdo command bodies loaded from the bundled submodule
const _slashdoCache = {};
async function loadSlashdoCommandBody(commandName) {
  // hasOwn instead of truthy check so we don't re-fetch when the file is
  // legitimately empty (cached '' would otherwise look the same as "not yet loaded").
  if (Object.hasOwn(_slashdoCache, commandName)) return _slashdoCache[commandName];
  _slashdoCache[commandName] = await loadSlashdoFile(commandName, { stripFrontmatter: true }) || '';
  return _slashdoCache[commandName];
}

/**
 * The slashdo review LENSES — the per-file / cross-file checklists that
 * `/do:review` dispatches its focused reviewers with — behind the
 * `{reviewLenses}` placeholder the public-review actions stage
 * (`pr-reviewer-review`) carries. `review-structural-ambition` is left out on
 * purpose: `/do:review` itself only selects it under `--strict`.
 *
 * That stage runs a single sandboxed agent with no network, no forge
 * credential, no sub-agent dispatch, and — on the local wrappers it is
 * commonly pinned to — a model server that prefills at a few hundred tokens per
 * second. The full `/do:review` body it used to receive is ~260KB: argument
 * parsing, reviewer-selection protocol, five reviewer LOOPS (Copilot, GitHub
 * `@login`, local agent, Ollama, multi-reviewer), issue filing and PR posting —
 * every one of them a procedure the stage's own contract forbids, and together
 * ~75K prompt tokens the model had to chew through before reading the PR. On
 * 2026-09-04 that prefill outlived Claude Code's stream-idle watchdog on every
 * attempt, so Stage 3 sat at `API error · Retrying … attempt 1/10` forever
 * (agent-e057cca7). The lenses are the review; the rest was the harness for a
 * different runtime.
 */
const PUBLIC_REVIEW_LENS_LIBS = [
  'review-surface-scan',
  'review-surface-quality',
  'review-security-audit',
  'review-cross-file-tracing',
  'review-cross-file-contract',
];
async function loadReviewLenses() {
  const lenses = await Promise.all(PUBLIC_REVIEW_LENS_LIBS.map((name) => loadSlashdoLib(name).catch(() => null)));
  return lenses.filter(Boolean).join('\n\n');
}

/**
 * Substitute the prompt-level placeholders. Every replacement is FUNCTION-form:
 * a string replacement makes `String.replace` interpret its `$`-prefixed
 * tokens (`$&`, `$n`, the "text before the match" and "text after the match"
 * forms) in the replacement text, and the shell-heavy slashdo bodies are full
 * of `$`. One "text before the match" token inside the inlined `/do:review` (a
 * regex like `^[^/]+/[^/]+#[0-9]+$` followed by a backtick) spliced EVERYTHING
 * BEFORE THE PLACEHOLDER back into the prompt at that point — seven copies of
 * the stage prompt inside one Stage 3 body, the same footgun
 * `resolveSlashdoIncludes` documents for its own includes.
 */
async function resolvePromptPlaceholders(prompt) {
  // {worktreesRoot} → PortOS's shared worktrees dir (absolute). The claim flows
  // (plan-task, claim-issue, claim-issue-gitlab, claim-issue-jira) create their
  // agent worktree here rather than inside the managed app repo, so a worktree
  // checkout never pollutes the target repo's working tree.
  if (prompt.includes('{worktreesRoot}')) {
    prompt = prompt.replace(/\{worktreesRoot\}/g, () => PATHS.worktrees);
  }
  if (prompt.includes('{reviewChecklist}')) {
    const checklist = await loadSlashdoCommandBody('review').catch(() => '');
    prompt = prompt.replace(/\{reviewChecklist\}/g, () => checklist);
  }
  if (prompt.includes('{reviewLenses}')) {
    const lenses = await loadReviewLenses();
    prompt = prompt.replace(/\{reviewLenses\}/g, () => lenses);
  }
  if (prompt.includes('{slashdoReplan}')) {
    const replan = await loadSlashdoCommandBody('replan').catch(() => '');
    prompt = prompt.replace(/\{slashdoReplan\}/g, () => replan);
  }
  return prompt;
}

export async function getTaskPrompt(taskType, { claimFlow = false } = {}) {
  const interval = await getTaskInterval(taskType);
  const storedDefault = claimFlow && promptMatchesShippedDefault(interval.prompt, taskType);
  let prompt = (interval.prompt && !storedDefault ? interval.prompt : null)
    || (claimFlow ? CLAIM_FLOW_DEFAULT_PROMPTS[taskType] : null)
    || DEFAULT_TASK_PROMPTS[taskType]
    || `[Improvement] ${taskType} analysis

Repository: {repoPath}

Perform ${taskType} analysis on {appName}.
Analyze the codebase and make improvements. Commit changes with clear descriptions.`;

  return resolvePromptPlaceholders(prompt);
}

/**
 * Get the prompt for a specific pipeline stage.
 * Resolves the promptKey from the stage definition in the task's pipeline config.
 */
export async function getStagePrompt(taskType, stageIndex) {
  const interval = await getTaskInterval(taskType);
  const stages = interval.taskMetadata?.pipeline?.stages;
  const stage = stages?.[stageIndex];
  if (!stage?.promptKey) return getTaskPrompt(taskType);
  const prompt = DEFAULT_TASK_PROMPTS[stage.promptKey];
  if (!prompt) return getTaskPrompt(taskType);
  return resolvePromptPlaceholders(prompt);
}
