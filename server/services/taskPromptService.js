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
 *   taskPromptService.js   taskSchedule.js
 *     └──────── static ───────┘  (this module imports getTaskInterval from taskSchedule)
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

import { loadSlashdoFile, PATHS } from '../lib/fileUtils.js';
import { getTaskInterval } from './taskSchedule.js';
import {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS
} from './taskPromptDefaults.js';

// Re-export the prompt data/compat constants so existing importers of this
// module keep working unchanged after the leaf split.
export {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS
};

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

async function resolvePromptPlaceholders(prompt) {
  // {worktreesRoot} → PortOS's shared worktrees dir (absolute). The claim flows
  // (plan-task, claim-issue, claim-issue-gitlab, claim-issue-jira) create their
  // agent worktree here rather than inside the managed app repo, so a worktree
  // checkout never pollutes the target repo's working tree. Function-form
  // replacer so a literal `$` in the path can't be read as a backreference.
  if (prompt.includes('{worktreesRoot}')) {
    prompt = prompt.replace(/\{worktreesRoot\}/g, () => PATHS.worktrees);
  }
  if (prompt.includes('{reviewChecklist}')) {
    const checklist = await loadSlashdoCommandBody('review').catch(() => '');
    prompt = prompt.replace(/\{reviewChecklist\}/g, checklist);
  }
  if (prompt.includes('{slashdoReplan}')) {
    const replan = await loadSlashdoCommandBody('replan').catch(() => '');
    prompt = prompt.replace(/\{slashdoReplan\}/g, replan);
  }
  return prompt;
}

export async function getTaskPrompt(taskType) {
  const interval = await getTaskInterval(taskType);
  let prompt = interval.prompt || DEFAULT_TASK_PROMPTS[taskType] || `[Improvement] ${taskType} analysis

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
