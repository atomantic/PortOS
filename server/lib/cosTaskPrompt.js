/**
 * The CoS task prompt/note split (#4153).
 *
 * `metadata.context` used to carry two unrelated kinds of content:
 *
 *   1. A one-line human note ("Manually triggered autonomous job: …").
 *   2. A multi-thousand-character AGENT PROMPT — the generator's Phase 1–7 body,
 *      a `/do:*` claim prompt, a repo-study brief. It landed there because
 *      `generateTasksMarkdown` flattens `description` onto one line and
 *      `parseTasksMarkdown` only matches a `- [ ]` block's first line, so a
 *      newline in `description` corrupts `COS-TASKS.md`. `metadata.context` is
 *      newline-escaped through the JSON sentinel, so it was the escape hatch
 *      that survived serialization.
 *
 * The two are now separate fields:
 *
 *   - `metadata.prompt`  — the full agent-facing payload.
 *   - `metadata.context` — the one-line human note.
 *
 * **Reads stay tolerant of the legacy shape.** PortOS is distributed software:
 * other installs and federated peers hold tasks written before the split, and
 * `scripts/migrations/270-cos-task-prompt-split.js` only rewrites the local
 * install's files. So every reader goes through `getTaskPrompt`, which prefers
 * `metadata.prompt` and falls back to `metadata.context`.
 *
 * Pure and side-effect free — no imports, safe for the migration to reuse.
 */

/** Metadata key holding the full agent-facing payload. */
export const TASK_PROMPT_KEY = 'prompt';

/** Metadata key holding the one-line human note. */
export const TASK_CONTEXT_KEY = 'context';

/**
 * Is this value a prompt payload rather than a one-line note?
 *
 * The discriminator is a newline: the `context` contract is explicitly "one line
 * of human note", so anything with a line break is by construction the other
 * thing. This is the SINGLE definition — the store's write path and the on-disk
 * migration both call it, so a task classified one way at creation can't be
 * classified the other way by the migration.
 *
 * Note `''` is NOT a prompt: an intentionally-cleared note stays a note (the
 * absent-vs-present-but-empty rule in AGENTS.md).
 */
export const isPromptPayload = (value) => typeof value === 'string' && value.includes('\n');

/**
 * The full agent-facing payload for a task, or `null` when it has none.
 *
 * Prefers `metadata.prompt`; falls back to `metadata.context` for tasks written
 * before the split (and for peers still on the old code). Returns `''` — not
 * `null` — when the field is present but empty, so a deliberate clear is
 * distinguishable from an absent field.
 */
export function getTaskPrompt(task) {
  const metadata = task?.metadata;
  if (typeof metadata?.[TASK_PROMPT_KEY] === 'string') return metadata[TASK_PROMPT_KEY];
  if (typeof metadata?.[TASK_CONTEXT_KEY] === 'string') return metadata[TASK_CONTEXT_KEY];
  return null;
}

/**
 * The one-line human note for a task, or `null` when it has none.
 *
 * Only a task that ALREADY carries `metadata.prompt` can have a distinct note —
 * on a legacy task `metadata.context` IS the prompt (see `getTaskPrompt`), and
 * returning it here as well would render the same body twice.
 */
export function getTaskContextNote(task) {
  const metadata = task?.metadata;
  if (typeof metadata?.[TASK_PROMPT_KEY] !== 'string') return null;
  return typeof metadata[TASK_CONTEXT_KEY] === 'string' ? metadata[TASK_CONTEXT_KEY] : null;
}

/**
 * The task's prompt + note rendered as ONE block, or `null` when the task has
 * neither. Every prompt-building path uses this so the split is invisible to the
 * templates (including the ones an install has customized): a legacy task
 * renders exactly what it rendered before, and a split task renders its payload
 * followed by its note. A queue-round-tripped task may already have folded the
 * prompt into `description`; in that shape, omit the duplicate prompt here while
 * retaining any separate note.
 */
export function taskContextBlock(task) {
  const prompt = getTaskPrompt(task);
  const promptIsAlreadyDescription = typeof prompt === 'string' && task?.description === prompt;
  const parts = [promptIsAlreadyDescription ? null : prompt, getTaskContextNote(task)]
    .filter(v => typeof v === 'string' && v.trim() !== '');
  return parts.length ? parts.join('\n\n') : null;
}

/**
 * Route a freshly-built task's metadata to the right field: a multi-line
 * `context` is the agent prompt, so it moves to `prompt`.
 *
 * Applied at CREATE only (`cosTaskStore.addTask`), never on update — the task
 * editor's textarea is seeded from the NOTE, and re-classifying a multi-line
 * edit of it would overwrite the task's real prompt. Producers that already
 * write `metadata.prompt` are left alone, so an explicit split always wins over
 * the inference.
 *
 * Returns the same object when nothing moved; otherwise a shallow clone (never
 * mutates the caller's metadata).
 */
export function splitTaskPromptFields(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  if (typeof metadata[TASK_PROMPT_KEY] === 'string') return metadata;
  if (!isPromptPayload(metadata[TASK_CONTEXT_KEY])) return metadata;
  const { [TASK_CONTEXT_KEY]: payload, ...rest } = metadata;
  return { ...rest, [TASK_PROMPT_KEY]: payload };
}
