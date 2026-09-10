import { callAI, parseJsonFromAI } from './meatspacePostLlm.js';
import {
  buildRhetoricEvaluatorPrompt,
  rhetoricEvaluationSchema,
  RHETORIC_EVALUATOR_RUBRIC_VERSION,
  validateRhetoricEvaluationPayload,
} from '../lib/postRhetoric.js';

/**
 * Evaluate one captured rhetoric attempt.
 *
 * The route intentionally owns no queue: the trainer serializes these calls in
 * the background so the next prompt can render immediately, while this bounded
 * request still records a complete provider/model/effort provenance object for
 * the round's final training entry.
 */
export async function evaluateRhetoricAttempt({
  attemptId,
  mode,
  prompt,
  response,
  providerId,
  model,
  effort,
}) {
  const startedAt = Date.now();
  const evaluatorPrompt = buildRhetoricEvaluatorPrompt({ mode, prompt, response });
  const aiResponse = await callAI(
    evaluatorPrompt,
    providerId,
    model,
    effort,
    'meatspace-post-rhetoric-evaluator',
  );
  const payload = validateRhetoricEvaluationPayload(mode, parseJsonFromAI(aiResponse.text, (value) => {
    try {
      validateRhetoricEvaluationPayload(mode, value);
      return true;
    } catch {
      return false;
    }
  }, evaluatorPrompt));
  const evaluation = rhetoricEvaluationSchema.parse({
    ...payload,
    provenance: {
      rubricVersion: RHETORIC_EVALUATOR_RUBRIC_VERSION,
      providerId: aiResponse.providerId,
      model: aiResponse.model,
      effort: effort || null,
    },
  });
  return {
    attemptId,
    mode,
    evaluation,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}
