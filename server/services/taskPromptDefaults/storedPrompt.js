import { DEFAULT_TASK_PROMPTS } from './prompts.js';
import { PROMPT_VERSIONS } from './versions.js';
import { promptMatchesShippedDefault } from './shippedPrompts.js';

/** Reconcile shipped defaults and inferred customizations without overwriting explicit user pins. */
export function reconcileStoredPrompt(config, taskType) {
  const currentPrompt = DEFAULT_TASK_PROMPTS[taskType];
  const currentVersion = PROMPT_VERSIONS[taskType] || 1;
  const fields = Object.fromEntries(
    ['prompt', 'promptVersion', 'promptCustomized', 'promptSource']
      .filter(key => Object.hasOwn(config, key))
      .map(key => [key, config[key]])
  );
  const finish = () => ({
    ...fields,
    changed: Object.keys(fields).some(key => fields[key] !== config[key])
  });

  // Missing body: install the current default and clear stale provenance.
  if (!fields.prompt && currentPrompt) {
    fields.prompt = currentPrompt;
    fields.promptVersion = currentVersion;
    if (fields.promptSource) fields.promptSource = null;
    return finish();
  }

  const isShippedDefault = promptMatchesShippedDefault(fields.prompt, taskType);
  const isCurrentDefault = fields.prompt === currentPrompt;

  // Legacy unversioned body: recognize defaults before inferring a customization.
  if (fields.prompt && fields.promptVersion === undefined && currentPrompt) {
    fields.promptVersion = isCurrentDefault || !isShippedDefault ? currentVersion : 1;
    if (!isShippedDefault) {
      fields.promptCustomized = true;
      fields.promptSource = 'legacy-inferred';
    }
  }

  // Inferred pin of a shipped body: repair both the flag and a misleading version.
  if (fields.promptSource !== 'user' && fields.promptCustomized && isShippedDefault) {
    fields.promptCustomized = false;
    if (!isCurrentDefault) fields.promptVersion = 1;
  }

  // Unpinned older version: replace the body with this release's default.
  if (PROMPT_VERSIONS[taskType] && !fields.promptCustomized
    && (fields.promptVersion || 1) < currentVersion) {
    fields.prompt = currentPrompt;
    fields.promptVersion = currentVersion;
  }
  return finish();
}

/** A Settings save pins only when the body is not the current default. */
export function stampPromptWrite(prompt, taskType) {
  const body = typeof prompt === 'string' && !prompt.trim() ? null : prompt;
  const promptCustomized = body != null && body !== DEFAULT_TASK_PROMPTS[taskType];
  return { prompt: body, promptCustomized, promptSource: promptCustomized ? 'user' : null };
}
