/**
 * Recognizing a stored prompt as a shipped default.
 *
 * Shared by taskScheduleStore.js (legacy-version inference + the
 * promptCustomized self-heal), taskPromptService.js (claim-flow default
 * resolution) and autonomousJobs/portosCatalogRefresh.js (migration prompt
 * carry-over), which each carried a byte-identical copy of this check.
 *
 * The match is byte-exact on purpose: a genuine user edit never reproduces a
 * shipped body, so a match means the stored prompt is safe to auto-upgrade.
 * Recovering a retired body is done by registering it in
 * PREVIOUS_DEFAULT_PROMPTS — never by teaching this predicate to forgive a
 * difference, which would widen "is a shipped default" for every consumer.
 *
 * See ../taskPromptDefaults.js and AGENTS.md "Distribution model".
 */
import { DEFAULT_TASK_PROMPTS } from './prompts.js';
import { PREVIOUS_DEFAULT_PROMPTS } from './previousDefaults.js';

export function promptMatchesShippedDefault(prompt, taskType) {
  if (!prompt || !DEFAULT_TASK_PROMPTS[taskType]) return false;
  return (
    prompt === DEFAULT_TASK_PROMPTS[taskType] ||
    (PREVIOUS_DEFAULT_PROMPTS[taskType] || []).includes(prompt)
  );
}
