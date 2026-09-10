/**
 * Task Prompt Defaults — data leaf (re-exporting barrel)
 *
 * Owns the default prompt catalog and the distribution-model compatibility
 * constants for scheduled improvement tasks. This module is a pure data leaf:
 * it imports nothing from the rest of the task-scheduling graph, so
 * taskPromptService.js (the getters), taskSchedule.js (status rendering), and
 * taskScheduleStore.js (the auto-upgrade machinery) can all import it
 * statically without forming a circular import.
 *
 * The content lives in ./taskPromptDefaults/ — prompts.js (current defaults),
 * versions.js (PROMPT_VERSIONS + audit anchor), shippedPrompts.js (the shared
 * "is this a shipped default?" check, which recognizes a retired default by its
 * hash in integrity.snapshot.json) — and this barrel re-exports it so existing
 * imports keep working. taskPromptDefaults.test.js pins the exported values
 * against that snapshot so a split/refactor can't silently alter the upgrade
 * contract.
 *
 * Distribution-model machinery (see AGENTS.md "Distribution model"):
 * - PROMPT_VERSIONS — bumped when a default prompt changes so existing installs auto-upgrade.
 * - integrity.snapshot.json → PREVIOUS_DEFAULT_PROMPTS — the md5 of every default
 *   a key has since replaced, recognized on read so a stored (non-customized)
 *   prompt can be safely auto-upgraded across installs/versions.
 * Do NOT change a prompt default without bumping PROMPT_VERSIONS and then
 * running `node scripts/regen-prompt-integrity-snapshot.js`, which retires the
 * outgoing default's hash onto that history. The retired bodies themselves are
 * not kept in the tree — git history has them.
 */

export { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults/prompts.js';
export { PROMPT_VERSIONS, REFERENCE_WATCH_AUDITED_VERSION } from './taskPromptDefaults/versions.js';
export { promptMatchesShippedDefault } from './taskPromptDefaults/shippedPrompts.js';
export { reconcileStoredPrompt, stampPromptWrite } from './taskPromptDefaults/storedPrompt.js';
