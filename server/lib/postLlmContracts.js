/**
 * Versioned POST LLM generation/scoring schemas, semantic-verdict validation, and secret-free
 * generator/scorer provenance with explicit legacy normalization.
 */

import { z } from 'zod';

export const POST_LLM_GENERATOR_SCHEMA_VERSION = '1';
export const POST_LLM_MAX_SEMANTIC_CANDIDATES = 200;
export const POST_LLM_PROMPT_VERSIONS = Object.freeze({
  'word-association': '1',
  'story-recall': '1',
  'verbal-fluency': '1',
  'wit-comeback': '1',
  'pun-wordplay': '1',
  'compound-chain': '1',
  'bridge-word': '1',
  'double-meaning': '1',
  'idiom-twist': '1',
  'what-if': '1',
  'alternative-uses': '1',
  'story-prompt': '1',
  'invention-pitch': '1',
  reframe: '1',
});

export const POST_LLM_RUBRIC_VERSIONS = Object.freeze(
  Object.fromEntries(Object.keys(POST_LLM_PROMPT_VERSIONS).map((type) => [type, '1'])),
);

const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(5000);
const responseItem = z.string().trim().min(1).max(500);
const rejectedResponseItem = z.string().max(500);
const difficulty = z.enum(['easy', 'medium', 'hard']);

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const compoundChainItemSchema = z.object({
  rootWord: shortText,
  position: z.enum(['prefix', 'suffix', 'both']),
  examples: z.array(shortText).min(10).max(15),
  minExpected: z.number().int().min(1).max(50),
}).superRefine((challenge, ctx) => {
  const root = normalizedKey(challenge.rootWord);
  const seen = new Set();
  challenge.examples.forEach((example, index) => {
    const normalized = normalizedKey(example);
    const inAllowedPosition = challenge.position === 'prefix'
      ? normalized.startsWith(root)
      : challenge.position === 'suffix'
        ? normalized.endsWith(root)
        : normalized.startsWith(root) || normalized.endsWith(root);
    if (!inAllowedPosition || normalized === root) {
      ctx.addIssue({
        code: 'custom', path: ['examples', index], message: 'example must contain the root in the declared position',
      });
    }
    if (seen.has(normalized)) {
      ctx.addIssue({ code: 'custom', path: ['examples', index], message: 'duplicate compound example' });
    }
    seen.add(normalized);
  });
});

const generationItemSchemas = {
  'word-association': z.object({
    prompt: shortText,
    hints: z.string().trim().max(500).optional().default(''),
  }),
  'story-recall': z.object({
    paragraph: longText,
    questions: z.array(z.object({
      question: shortText,
      answer: shortText,
      aliases: z.array(shortText).max(10).optional().default([]),
    })).min(3).max(4),
  }),
  'verbal-fluency': z.object({
    category: shortText,
    minExpected: z.number().int().min(1).max(100),
    examples: z.array(shortText).min(3).max(5),
  }),
  'wit-comeback': z.object({
    setup: longText,
    context: z.string().trim().max(1000).optional().default(''),
    difficulty,
  }),
  'pun-wordplay': z.object({
    type: z.enum(['pun-topic', 'complete-sentence', 'punny-name', 'wordplay-headline']),
    prompt: longText,
    topic: shortText,
    example: longText,
  }),
  'compound-chain': compoundChainItemSchema,
  'bridge-word': z.object({
    clues: z.array(shortText).min(3).max(4),
    answer: shortText,
    difficulty: difficulty.optional().default('medium'),
    hint: z.string().trim().max(500).optional().default(''),
  }),
  'double-meaning': z.object({
    word: shortText,
    meanings: z.array(shortText).min(2).max(5),
    example: z.string().trim().max(2000).optional().default(''),
    difficulty: difficulty.optional().default('medium'),
  }),
  'idiom-twist': z.object({
    idiom: shortText,
    domain: shortText,
    example: z.string().trim().max(2000).optional().default(''),
    difficulty: difficulty.optional().default('medium'),
  }),
  'what-if': z.object({ prompt: longText, category: shortText }),
  'alternative-uses': z.object({
    object: shortText,
    commonUse: shortText,
    minExpected: z.number().int().min(1).max(100),
  }),
  'story-prompt': z.object({ words: z.array(shortText).length(3) }),
  'invention-pitch': z.object({ problem: longText, category: shortText, difficulty }),
  reframe: z.object({ situation: longText, severity: z.enum(['low', 'medium', 'high']) }),
};

const generationFields = {
  'word-association': 'questions',
  'story-recall': 'exercises',
  'verbal-fluency': 'categories',
  'wit-comeback': 'scenarios',
  'pun-wordplay': 'challenges',
  'compound-chain': 'challenges',
  'bridge-word': 'puzzles',
  'double-meaning': 'challenges',
  'idiom-twist': 'challenges',
  'what-if': 'scenarios',
  'alternative-uses': 'objects',
  'story-prompt': 'prompts',
  'invention-pitch': 'problems',
  reframe: 'situations',
};

const identity = z.string().trim().min(1).max(300);

export const postLlmGeneratorProvenanceSchema = z.object({
  schemaVersion: identity,
  promptVersion: identity,
  providerId: identity,
  model: identity,
});

export const postLlmScorerProvenanceSchema = z.object({
  kind: z.enum(['local', 'llm', 'hybrid', 'legacy']),
  rubricVersion: identity,
  providerId: identity,
  model: identity,
});

export const postLlmEvaluationProvenanceSchema = z.object({
  generator: postLlmGeneratorProvenanceSchema,
  scorer: postLlmScorerProvenanceSchema,
});

export const LEGACY_POST_LLM_PROVENANCE = Object.freeze({
  generator: Object.freeze({
    schemaVersion: 'legacy', promptVersion: 'legacy', providerId: 'legacy', model: 'legacy',
  }),
  scorer: Object.freeze({
    kind: 'legacy', rubricVersion: 'legacy', providerId: 'legacy', model: 'legacy',
  }),
});

export const postLlmEvaluationScoreSchema = z.object({
  score: z.number().min(0).max(100),
  feedback: z.string().max(2000),
  validCount: z.number().int().min(0).optional(),
  validItems: z.array(responseItem).max(200).optional(),
  invalidItems: z.array(rejectedResponseItem).max(200).optional(),
  duplicateItems: z.array(rejectedResponseItem).max(200).optional(),
  missedExamples: z.array(responseItem).max(200).optional(),
});

const currentEvaluationSchema = z.object({
  overallScore: z.number().min(0).max(100),
  scores: z.array(postLlmEvaluationScoreSchema).max(100),
  summary: z.string().max(4000),
  provenance: postLlmEvaluationProvenanceSchema,
});

const historicalEvaluationScoreSchema = z.object({
  score: z.number().min(0).max(100).optional(),
  feedback: z.string().optional().default(''),
  validCount: z.number().int().min(0).optional(),
  validItems: z.array(z.string()).optional(),
  invalidItems: z.array(z.string()).optional(),
  duplicateItems: z.array(z.string()).optional(),
  missedExamples: z.array(z.string()).optional(),
});

const historicalEvaluationSchema = z.object({
  overallScore: z.number().min(0).max(100).optional(),
  scores: z.array(historicalEvaluationScoreSchema),
  summary: z.string(),
  provenance: postLlmEvaluationProvenanceSchema,
});

function legacyEvaluation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if ('overallScore' in value) {
    return {
      ...value,
      scores: Array.isArray(value.scores) ? value.scores : [],
      summary: typeof value.summary === 'string' ? value.summary : 'Legacy evaluation',
      provenance: value.provenance || LEGACY_POST_LLM_PROVENANCE,
    };
  }
  if ('score' in value || Array.isArray(value.breakdown)) {
    const scores = (value.breakdown || []).map((item) => ({
      score: item?.score,
      feedback: item?.feedback || '',
    }));
    const derivedScore = scores.length && scores.every((item) => Number.isFinite(item.score))
      ? Math.round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length)
      : undefined;
    return {
      overallScore: value.score ?? derivedScore,
      scores,
      summary: 'Legacy evaluation',
      provenance: LEGACY_POST_LLM_PROVENANCE,
    };
  }
  return {
    overallScore: undefined,
    scores: [],
    summary: 'Legacy evaluation',
    provenance: LEGACY_POST_LLM_PROVENANCE,
  };
}

export const postLlmEvaluationSchema = z.preprocess(legacyEvaluation, currentEvaluationSchema);
const historicalPostLlmEvaluationSchema = z.preprocess(legacyEvaluation, historicalEvaluationSchema);

function contractError(label, issues) {
  const details = issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : 'response'}: ${issue.message}`)
    .join('; ');
  return new Error(`Invalid ${label}: ${details}`);
}

function parseContract(schema, value, label) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw contractError(label, parsed.error.issues);
  return parsed.data;
}

export function validatePostLlmGenerationPayload(type, value, count) {
  const field = generationFields[type];
  const itemSchema = generationItemSchemas[type];
  if (!field || !itemSchema) throw new Error(`Unsupported POST LLM generator type: ${type}`);
  const schema = z.object({ [field]: z.array(itemSchema).length(count) });
  return parseContract(schema, value, `${type} generation response`);
}

export function validatePostLlmScorePayload(value, responseCount) {
  const schema = z.object({
    overallScore: z.number().min(0).max(100),
    scores: z.array(postLlmEvaluationScoreSchema).length(responseCount),
    summary: z.string().max(4000),
  });
  return parseContract(schema, value, 'POST LLM scoring response');
}

export function validatePostLlmSemanticVerdicts(value, candidates, label) {
  const keys = new Set(candidates.map(({ responseIndex, itemIndex }) => `${responseIndex}:${itemIndex}`));
  const schema = z.object({
    verdicts: z.array(z.object({
      responseIndex: z.number().int().min(0),
      itemIndex: z.number().int().min(0),
      valid: z.boolean(),
      reason: z.string().max(500).optional(),
    })).length(candidates.length),
  }).superRefine((data, ctx) => {
    const seen = new Set();
    data.verdicts.forEach((verdict, index) => {
      const key = `${verdict.responseIndex}:${verdict.itemIndex}`;
      if (!keys.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['verdicts', index], message: 'verdict does not match a submitted item' });
      } else if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['verdicts', index], message: 'duplicate verdict for submitted item' });
      }
      seen.add(key);
    });
    for (const key of keys) {
      if (!seen.has(key)) ctx.addIssue({ code: 'custom', path: ['verdicts'], message: `missing verdict for ${key}` });
    }
  });
  return parseContract(schema, value, label);
}

export function buildPostLlmGeneratorProvenance(type, providerId, model) {
  return postLlmGeneratorProvenanceSchema.parse({
    schemaVersion: POST_LLM_GENERATOR_SCHEMA_VERSION,
    promptVersion: POST_LLM_PROMPT_VERSIONS[type],
    providerId,
    model,
  });
}

export function buildPostLlmScorerProvenance(type, kind, providerId, model) {
  return postLlmScorerProvenanceSchema.parse({
    kind,
    rubricVersion: POST_LLM_RUBRIC_VERSIONS[type],
    providerId,
    model,
  });
}

export function normalizePostLlmEvaluation(value) {
  return postLlmEvaluationSchema.parse(value);
}

export function normalizeHistoricalPostLlmEvaluation(value) {
  return historicalPostLlmEvaluationSchema.parse(value);
}
