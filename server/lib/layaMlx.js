import { z } from 'zod';

// Runtime and weights are independently pinned. Never download during scoring.
export const LAYA_MLX = Object.freeze({
  id: 'laya-mlx',
  name: 'Laya-MLX multilingual',
  repository: 'aac6fef/laya-multilingual-mlx',
  revision: 'ba40c87fcb357f1643d04d71323af9cdc3b9e591',
  runtimeRevision: 'fc1df62828a3fedf4d8229fdac1cbd85f1cdf337',
  contextTokens: 1024,
  parameters: '322M',
});

export const layaScoreRequestSchema = z.object({
  premise: z.string().trim().min(1).max(12000),
  instructions: z.string().trim().min(1).max(1000),
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(12)
    .refine(values => new Set(values).size === values.length, 'Options must be unique'),
  minMargin: z.number().min(0).max(1).default(0.15),
}).strict();

// Laya's entropy-based confidence is NOT Jev's entailment probability. Preserve
// its meaning and independently compute an experimental winner/runner-up margin.
export function normalizeLayaResult(raw, options, minMargin) {
  const answer = raw?.answers?.decision;
  const probabilities = answer?.probabilities;
  if (answer?.type !== 'choice' || !probabilities || typeof probabilities !== 'object'
    || Object.keys(probabilities).length !== options.length
    || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return null;
  const scores = options.map(option => ({ option, probability: Object.hasOwn(probabilities, option) ? probabilities[option] : null }));
  if (scores.some(row => !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1)) return null;
  if (Math.abs(scores.reduce((sum, row) => sum + row.probability, 0) - 1) > 0.002) return null;
  const ranked = [...scores].sort((a, b) => b.probability - a.probability);
  if (answer.choice !== ranked[0].option) return null;
  const margin = ranked[0].probability - ranked[1].probability;
  const abstained = margin <= 0 || margin < minMargin;
  return { ok: true, classifier: LAYA_MLX.id, choice: abstained ? null : answer.choice,
    abstained, margin, entropyConfidence: answer.confidence, scores };
}
