import { z } from 'zod';
import { PERSISTENT_MIND_CHOSEN_NAME_TAG } from './persistentMindChosenName.js';
import { memoryIdSchema } from './memoryValidation.js';

// Use the existing durable tags column in both memory backends. No new store,
// record format, or federation payload is needed for this machine-local policy.
export const PERSISTENT_MIND_MEMORY_PROTECTION_TAGS = Object.freeze({
  'core-identity': 'mind:core-identity',
  important: 'mind:important',
});

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
  const reserved = Object.values(PERSISTENT_MIND_MEMORY_PROTECTION_TAGS);
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
