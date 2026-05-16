import { runStagedLLM } from '../../lib/stageRunner.js';
import { ServerError } from '../../lib/errorHandler.js';

// Shared scaffolding for every pipeline LLM refine path (comic-panel,
// storyboard-scene, character-physicalDescription). Owns the runStagedLLM call,
// the empty-result guard, the changes-array shaping, and the runId log. Callers
// pass `resultField` (e.g. 'prompt' or 'physicalDescription') so this helper
// stays prompt-agnostic.
export async function runPromptRefine({
  templateName,
  variables,
  options = {},
  source,
  logTag,
  resultField = 'prompt',
  emptyError = { code: 'PIPELINE_PROMPT_REFINE_EMPTY', message: 'LLM returned an empty refined prompt' },
  changesLimit = 8,
}) {
  const result = await runStagedLLM(templateName, variables, {
    providerOverride: options.providerId,
    modelOverride: options.model,
    returnsJson: true,
    source,
  });
  const refined = (result.content?.[resultField] || '').trim();
  if (!refined) {
    throw new ServerError(emptyError.message, { status: 502, code: emptyError.code });
  }
  const changes = Array.isArray(result.content?.changes)
    ? result.content.changes.map((c) => String(c).slice(0, 240)).filter(Boolean).slice(0, changesLimit)
    : [];
  const rationale = typeof result.content?.rationale === 'string'
    ? result.content.rationale.trim()
    : '';
  console.log(`✨ ${logTag} runId=${(result.runId || '').slice(0, 8)}`);
  return { refined, changes, rationale, runId: result.runId, providerId: result.providerId, model: result.model };
}
