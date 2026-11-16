/**
 * The CoS task prompt/note split (#4153).
 *
 * `metadata.prompt` is the full agent-facing
 * payload, `metadata.context` the one-line human note (a newline in `description`
 * corrupts `COS-TASKS.md`, which is why prompts once hid in the escaped `context`).
 *
 * Reads stay tolerant of the legacy shape (peers hold pre-split tasks; migration 270
 * only rewrites local files). Pure, no imports, safe for the migration to reuse.
 */

export const TASK_PROMPT_KEY = 'prompt';

export const TASK_CONTEXT_KEY = 'context';

/** A newline discriminates prompt from note; shared by the store and the migration. `''` stays a note. */
export const isPromptPayload = (value) => typeof value === 'string' && value.includes('\n');

/** Full payload or `null`; prefers `prompt`, falls back to legacy `context`. Present-but-empty is `''`. */
export function getTaskPrompt(task) {
  const metadata = task?.metadata;
  if (typeof metadata?.[TASK_PROMPT_KEY] === 'string') return metadata[TASK_PROMPT_KEY];
  if (typeof metadata?.[TASK_CONTEXT_KEY] === 'string') return metadata[TASK_CONTEXT_KEY];
  return null;
}

/** The note, or `null`; on a legacy task `context` IS the prompt, so there is none. */
export function getTaskContextNote(task) {
  const metadata = task?.metadata;
  if (typeof metadata?.[TASK_PROMPT_KEY] !== 'string') return null;
  return typeof metadata[TASK_CONTEXT_KEY] === 'string' ? metadata[TASK_CONTEXT_KEY] : null;
}

/** Prompt + note as ONE block (or `null`); omits a prompt already folded into `description`. */
export function taskContextBlock(task) {
  const prompt = getTaskPrompt(task);
  // startsWith, not ===: applySlashdoInvocation appends a section to the description after the prompt was folded in.
  const promptIsAlreadyDescription = typeof prompt === 'string' && prompt.trim() !== ''
    && typeof task?.description === 'string' && task.description.startsWith(prompt);
  const parts = [promptIsAlreadyDescription ? null : prompt, getTaskContextNote(task)]
    .filter(v => typeof v === 'string' && v.trim() !== '');
  return parts.length ? parts.join('\n\n') : null;
}

/**
 * Move a multi-line `context` to `prompt` on a freshly-built task's metadata.
 *
 * CREATE only (`cosTaskStore.addTask`): the editor textarea is seeded from the NOTE,
 * so re-classifying on update would overwrite the real prompt. An explicit
 * `metadata.prompt` always wins. Returns the same object when nothing moved, else
 * a shallow clone.
 */
export function splitTaskPromptFields(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  if (typeof metadata[TASK_PROMPT_KEY] === 'string') return metadata;
  if (!isPromptPayload(metadata[TASK_CONTEXT_KEY])) return metadata;
  const { [TASK_CONTEXT_KEY]: payload, ...rest } = metadata;
  return { ...rest, [TASK_PROMPT_KEY]: payload };
}
