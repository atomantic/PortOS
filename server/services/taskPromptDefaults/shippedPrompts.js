/**
 * Recognizing a stored prompt as a shipped default.
 *
 * Shared by taskScheduleStore.js (legacy-version inference + the
 * promptCustomized self-heal), taskPromptService.js (claim-flow default
 * resolution) and autonomousJobs/portosCatalogRefresh.js (migration prompt
 * carry-over), which each carried a byte-identical copy of this check.
 *
 * The match is exact on purpose: a genuine user edit never reproduces a shipped
 * body, so a match means the stored prompt is safe to auto-upgrade. The current
 * default is compared byte-for-byte; a retired default is recognized by its md5
 * in integrity.snapshot.json's PREVIOUS_DEFAULT_PROMPTS history, which the bump
 * tool extends on every PROMPT_VERSIONS bump (see integrityHash.js for the
 * origin folding and the tool). A retired body is recovered by preserving its
 * hash — never by teaching this predicate to forgive a difference, which would
 * widen "is a shipped default" for every consumer.
 *
 * See ../taskPromptDefaults.js and AGENTS.md "Distribution model".
 */
import { DEFAULT_TASK_PROMPTS } from './prompts.js';
import { hashPromptBody, readPromptIntegritySnapshot } from './integrityHash.js';

const RETIRED_PROMPT_HASHES = readPromptIntegritySnapshot().PREVIOUS_DEFAULT_PROMPTS;

export function promptMatchesShippedDefault(prompt, taskType) {
  if (!prompt || !DEFAULT_TASK_PROMPTS[taskType]) return false;
  if (prompt === DEFAULT_TASK_PROMPTS[taskType]) return true;
  return Boolean(RETIRED_PROMPT_HASHES[taskType]?.includes(hashPromptBody(prompt)));
}
