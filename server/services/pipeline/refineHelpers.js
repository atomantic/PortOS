import { runStagedLLM } from '../../lib/stageRunner.js';
import { ServerError } from '../../lib/errorHandler.js';

// Pass `logTag: null` to suppress the default runId log so a caller that
// needs a context-rich line (e.g. universeCharacterExpand wants the
// field-count) can emit its own after the post-merge state is known.
export async function runPromptRefineRaw({
  templateName,
  variables,
  options = {},
  source,
  logTag,
  emptyError = { code: 'PIPELINE_PROMPT_REFINE_EMPTY', message: 'LLM returned an empty payload' },
  validateContent,
}) {
  const result = await runStagedLLM(templateName, variables, {
    providerOverride: options.providerId,
    modelOverride: options.model,
    returnsJson: true,
    source,
  });
  const content = result.content;
  // Reject array AND non-object — `typeof [] === 'object'` would otherwise
  // let an LLM that returned `[{...}]` slip through downstream merges as a
  // valid-but-empty payload (no string keys match) and silently no-op.
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new ServerError(emptyError.message, { status: 502, code: emptyError.code });
  }
  if (validateContent) validateContent(content);
  const rationale = typeof content.rationale === 'string' ? content.rationale.trim() : '';
  if (logTag) {
    console.log(`✨ ${logTag} runId=${(result.runId || '').slice(0, 8)}`);
  }
  return { content, rationale, runId: result.runId, providerId: result.providerId, model: result.model };
}

// Single-field refine wrapper for the comic-panel / storyboard-scene /
// character-physicalDescription paths. `resultField` keeps the helper
// prompt-agnostic; `changes` are trimmed + capped on the way out.
export async function runPromptRefine({
  resultField = 'prompt',
  emptyError = { code: 'PIPELINE_PROMPT_REFINE_EMPTY', message: 'LLM returned an empty refined prompt' },
  changesLimit = 8,
  ...rest
}) {
  const validateContent = (c) => {
    // Type-gate: an LLM that returned `{ prompt: 42 }` or `{ prompt: { ... } }`
    // would otherwise blow up on `.trim()` or silently coerce to garbage. Treat
    // any non-string as missing.
    const raw = c?.[resultField];
    const refined = typeof raw === 'string' ? raw.trim() : '';
    if (!refined) {
      throw new ServerError(emptyError.message, { status: 502, code: emptyError.code });
    }
  };
  const { content, ...meta } = await runPromptRefineRaw({ ...rest, validateContent, emptyError });
  // `validateContent` already guarantees a non-empty string at this index.
  const refined = content[resultField].trim();
  const changes = Array.isArray(content.changes)
    ? content.changes.map((c) => String(c).slice(0, 240)).filter(Boolean).slice(0, changesLimit)
    : [];
  return { refined, changes, ...meta };
}
