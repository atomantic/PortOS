import { z } from 'zod';
import { ServerError } from './errorHandler.js';
import { PERSISTENT_MIND_CHOSEN_NAME_TAG } from './persistentMindChosenName.js';
import { memoryIdSchema } from './memoryValidation.js';

// Use the existing durable tags column in both memory backends. No new store,
// record format, or federation payload is needed for this machine-local policy.
export const PERSISTENT_MIND_MEMORY_PROTECTION_TAGS = Object.freeze({
  'core-identity': 'mind:core-identity',
  important: 'mind:important',
});

// The one current note the mind leaves its next wake. Only the continuation
// writer may apply this tag; every other tag path strips it, so a memory
// candidate, panel edit, or promotion cannot pose as the note.
export const PERSISTENT_MIND_CONTINUATION_TAG = 'mind:continuation-note';
export const PERSISTENT_MIND_CONTINUATION_NOTE_MAX_CHARS = 4_000;

// null is a local model's spelling of an absent field, so it preserves the note;
// only an explicit empty string clears it.
export const persistentMindContinuationNoteSchema = z.string().trim()
  .max(PERSISTENT_MIND_CONTINUATION_NOTE_MAX_CHARS)
  .nullish()
  .transform((value) => value ?? undefined);

export const isPersistentMindContinuationNote = (memory) => Array.isArray(memory?.tags)
  && memory.tags.includes(PERSISTENT_MIND_CONTINUATION_TAG);

export const persistentMindContinuationNoteTags = () => [
  PERSISTENT_MIND_CONTINUATION_TAG,
  PERSISTENT_MIND_MEMORY_PROTECTION_TAGS.important,
];

export const persistentMindMemoryProtectionSchema = z.enum(['standard', 'important', 'core-identity']);
export const persistentMindProtectMemorySchema = z.object({
  memoryId: memoryIdSchema.max(128),
  protection: z.enum(['important', 'core-identity']),
}).strict();

export function persistentMindMemoryProtection(memory) {
  const tags = Array.isArray(memory?.tags) ? memory.tags : [];
  return Object.keys(PERSISTENT_MIND_MEMORY_PROTECTION_TAGS)
    .find((level) => tags.includes(PERSISTENT_MIND_MEMORY_PROTECTION_TAGS[level])) || 'standard';
}

export function persistentMindMemoryTags(tags, protection) {
  const level = persistentMindMemoryProtectionSchema.parse(protection);
  const reserved = [...Object.values(PERSISTENT_MIND_MEMORY_PROTECTION_TAGS), PERSISTENT_MIND_CONTINUATION_TAG];
  const ordinary = [...new Set((Array.isArray(tags) ? tags : [])
    .filter((tag) => typeof tag === 'string' && tag && !reserved.includes(tag)))];
  const marker = PERSISTENT_MIND_MEMORY_PROTECTION_TAGS[level];
  return marker ? [...ordinary.slice(0, 19), marker] : ordinary.slice(0, 20);
}

export function comparePersistentMindMemories(a, b) {
  const rank = { 'core-identity': 2, important: 1, standard: 0 };
  return Number(b.tags?.includes(PERSISTENT_MIND_CHOSEN_NAME_TAG) || false) - Number(a.tags?.includes(PERSISTENT_MIND_CHOSEN_NAME_TAG) || false)
    || rank[persistentMindMemoryProtection(b)] - rank[persistentMindMemoryProtection(a)]
    || (b.importance ?? 0.5) - (a.importance ?? 0.5);
}

export const projectPersistentMindMemory = (memory) => memory
  ? { ...memory, protection: persistentMindMemoryProtection(memory) }
  : null;

// At most one outcome per verdict/content version. Authorship is supplied separately
// by the executing mind runtime, never accepted in model arguments.
export const persistentMindReviewMemorySchema = z.object({
  memoryId: memoryIdSchema.max(128),
  expectedVersion: z.number().int().min(1),
  verdict: z.enum(['keep', 'learn', 'archive', 'defer']),
  rationale: z.string().max(4000).optional(),
  lesson: z.string().min(1).max(10240).optional(),
}).strict();

export function validatePersistentMindReview(input) {
  const parsed = persistentMindReviewMemorySchema.parse(input);
  if ((parsed.verdict === 'learn' && !parsed.lesson?.trim())
      || (parsed.verdict !== 'learn' && parsed.lesson !== undefined)) {
    throw new ServerError('Only learn requires a nonempty lesson; other verdicts cannot include one', { status: 400 });
  }
  return parsed;
}

export function existingPersistentMindReview(memory, input, mindId) {
  if (!memory || memory.sourceAgentId !== mindId) {
    throw new ServerError('Mind-owned memory not found', { status: 404 });
  }
  if ((memory.version ?? 1) !== input.expectedVersion) {
    throw new ServerError('Memory changed since it was loaded. Reload before reviewing.', { status: 409, code: 'MEMORY_VERSION_CONFLICT' });
  }
  if (input.verdict === 'archive' && persistentMindMemoryProtection(memory) !== 'standard') {
    throw new ServerError('Protected memories cannot be archived', { status: 409, code: 'MEMORY_PROTECTED' });
  }
  const outcomes = memory.lastReview?.expectedVersion === input.expectedVersion ? memory.lastReview.outcomes : null;
  const previous = outcomes?.[input.verdict];
  if (previous) {
    if (previous.rationale !== (input.rationale ?? null)
        || previous.lesson !== (input.lesson ?? null)) {
      throw new ServerError('This verdict already has a different review for this memory version', { status: 409, code: 'MEMORY_REVIEW_CONFLICT' });
    }
    const expectedStatus = outcomes.archive ? 'archived' : 'active';
    if (memory.status !== expectedStatus) throw new ServerError('Memory status changed since review', { status: 409 });
    return previous;
  }
  if (memory.status !== 'active') throw new ServerError('Only active memories can be reviewed', { status: 409 });
  return null;
}

export function createPersistentMindReview(input, provenance, lessonId = null) {
  return {
    expectedVersion: input.expectedVersion, verdict: input.verdict,
    rationale: input.rationale ?? null, lesson: input.lesson ?? null, lessonId,
    mindId: provenance.mindId, turnId: provenance.turnId,
    providerId: provenance.providerId, model: provenance.model,
    reviewedAt: new Date().toISOString(),
  };
}

export function mergePersistentMindReview(memory, review) {
  return {
    expectedVersion: review.expectedVersion, latestVerdict: review.verdict,
    outcomes: {
      ...(memory.lastReview?.expectedVersion === review.expectedVersion ? memory.lastReview.outcomes : {}),
      [review.verdict]: review,
    },
  };
}

export function createPersistentMindReviewOrigin(input, provenance) {
  return {
    sourceId: input.memoryId, sourceVersion: input.expectedVersion,
    mindId: provenance.mindId, turnId: provenance.turnId,
    providerId: provenance.providerId, model: provenance.model,
    reviewedAt: new Date().toISOString(),
  };
}
