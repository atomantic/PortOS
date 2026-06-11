/**
 * Task Prompt Defaults — data leaf (re-exporting barrel)
 *
 * Owns the default prompt catalog and the distribution-model compatibility
 * constants for scheduled improvement tasks. This module is a pure data leaf:
 * it imports nothing from the rest of the task-scheduling graph, so both
 * taskPromptService.js (the getters) and taskSchedule.js (the auto-upgrade
 * machinery) can import it statically without forming a circular import.
 *
 * The content lives in ./taskPromptDefaults/ — prompts.js (current defaults),
 * versions.js (PROMPT_VERSIONS + audit anchor), previousDefaults.js (prior
 * shipped defaults) — and this barrel re-exports it so existing imports keep
 * working. taskPromptDefaults.test.js pins the exported values against a hash
 * snapshot so a split/refactor can't silently alter the upgrade contract.
 *
 * Distribution-model machinery (see CLAUDE.md "Distribution model"):
 * - PROMPT_VERSIONS — bumped when a default prompt changes so existing installs auto-upgrade.
 * - PREVIOUS_DEFAULT_PROMPTS — prior shipped defaults, recognized on read so a stored
 *   (non-customized) prompt can be safely auto-upgraded across installs/versions.
 * Do NOT change prompt defaults without bumping PROMPT_VERSIONS and preserving
 * the prior default in PREVIOUS_DEFAULT_PROMPTS (and updating the snapshot).
 */

export { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults/prompts.js';
export { PROMPT_VERSIONS, REFERENCE_WATCH_AUDITED_VERSION } from './taskPromptDefaults/versions.js';
export { PREVIOUS_DEFAULT_PROMPTS } from './taskPromptDefaults/previousDefaults.js';
