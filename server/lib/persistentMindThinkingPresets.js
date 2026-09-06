/**
 * Named temporary thinking presets for the persistent CoS mind.
 *
 * `persistentMindProfile.js` owns the mind's ONE home route — the identity it
 * wakes on by default. This module owns the user's saved alternates: exact
 * provider/model/effort routes that a single explicitly-selected message may
 * borrow for one turn. A preset is inert storage. Saving, editing, or removing
 * one never starts a mind, never contacts a provider, and never changes which
 * route the next ordinary message or scheduled wake takes.
 *
 * Presets are deliberately NOT a fallback pool. Resolution is exact-or-refuse
 * (`services/persistentMindProfile.js`), because a mind answering on a route
 * the user did not select is a different identity, not a recovery.
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from './providerModels.js';

export const PERSISTENT_MIND_THINKING_PRESETS_SCHEMA_VERSION = 1;

export const PERSISTENT_MIND_THINKING_PRESET_LIMITS = Object.freeze({
  MAX_PRESETS: 20,
  ID_MAX: 64,
  LABEL_MAX: 80,
  PROVIDER_ID_MAX: 100,
  MODEL_MAX: 200,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const persistentMindThinkingPresetSchema = z.object({
  id: z.string().trim().min(1).max(PERSISTENT_MIND_THINKING_PRESET_LIMITS.ID_MAX).regex(ID_PATTERN),
  label: z.string().trim().max(PERSISTENT_MIND_THINKING_PRESET_LIMITS.LABEL_MAX).optional(),
  providerId: z.string().trim().min(1).max(PERSISTENT_MIND_THINKING_PRESET_LIMITS.PROVIDER_ID_MAX),
  model: z.string().trim().min(1).max(PERSISTENT_MIND_THINKING_PRESET_LIMITS.MODEL_MAX),
  // Empty is the UI's explicit "provider default effort" sentinel, mirroring
  // the home profile so one selector can drive both.
  effort: z.union([z.literal(''), z.enum(EFFORT_LEVELS)]).optional(),
}).strict();

// Accepted messages require an explicit effort sentinel too: a missing field
// on an old/partial record is not permission to use the provider default.
export const persistentMindThinkingSelectionSchema = persistentMindThinkingPresetSchema
  .required({ effort: true });

export function normalizePersistentMindThinkingSelection(value) {
  const parsed = persistentMindThinkingSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Labels are presentation; only the exact route participates in consent. */
export function samePersistentMindThinkingSelection(left, right) {
  const a = normalizePersistentMindThinkingSelection(left);
  const b = normalizePersistentMindThinkingSelection(right);
  return Boolean(a && b && ['id', 'providerId', 'model', 'effort'].every((key) => a[key] === b[key]));
}

export const persistentMindThinkingPresetsSchema = z.object({
  schemaVersion: z.literal(PERSISTENT_MIND_THINKING_PRESETS_SCHEMA_VERSION).optional(),
  // A list PATCH replaces the whole list: there is no stable way to express
  // "remove this one entry" through a merge, and a partial merge would silently
  // resurrect a preset the user just deleted.
  presets: z.array(persistentMindThinkingPresetSchema)
    .max(PERSISTENT_MIND_THINKING_PRESET_LIMITS.MAX_PRESETS),
}).strict();

export function createDefaultPersistentMindThinkingPresets() {
  return {
    schemaVersion: PERSISTENT_MIND_THINKING_PRESETS_SCHEMA_VERSION,
    presets: [],
  };
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Coerce a preset reference to the exact stored id, or null.
 *
 * Exported so the durable message record validates a selection against the
 * same rule the preset list itself enforces, rather than re-deriving it.
 */
export function asPersistentMindThinkingPresetId(value) {
  const id = text(value, PERSISTENT_MIND_THINKING_PRESET_LIMITS.ID_MAX);
  return ID_PATTERN.test(id) ? id : null;
}

const storedThinkingPresetSchema = persistentMindThinkingPresetSchema.strip();

const sanitizePreset = (value) => {
  // Retain the legacy id/label repairs. Provider/model/effort are exact route
  // fields: invalid values there must be refused, never truncated or defaulted.
  const parsed = storedThinkingPresetSchema.safeParse({
    ...value,
    id: asPersistentMindThinkingPresetId(value?.id),
    label: text(value?.label, PERSISTENT_MIND_THINKING_PRESET_LIMITS.LABEL_MAX),
  });
  if (!parsed.success) return null;
  const { id, providerId, model, effort = '', label } = parsed.data;
  return {
    id,
    label: label || text(`${providerId} / ${model}`, PERSISTENT_MIND_THINKING_PRESET_LIMITS.LABEL_MAX),
    providerId,
    model,
    effort,
  };
};

/** Normalize legacy or hand-edited config without inventing a route. */
export function normalizePersistentMindThinkingPresets(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const presets = [];
  const seen = new Set();
  for (const candidate of Array.isArray(source.presets) ? source.presets : []) {
    const preset = sanitizePreset(candidate);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    presets.push(preset);
    if (presets.length >= PERSISTENT_MIND_THINKING_PRESET_LIMITS.MAX_PRESETS) break;
  }
  return { schemaVersion: PERSISTENT_MIND_THINKING_PRESETS_SCHEMA_VERSION, presets };
}

/** Apply a settings patch. An absent `presets` key preserves the stored list. */
export function mergePersistentMindThinkingPresets(previous, update) {
  const prior = normalizePersistentMindThinkingPresets(previous);
  const patch = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  return normalizePersistentMindThinkingPresets(
    Array.isArray(patch.presets) ? { presets: patch.presets } : prior,
  );
}

/** Look up one saved preset. Returns null for an unknown or removed id. */
export function findPersistentMindThinkingPreset(raw, presetId) {
  const id = asPersistentMindThinkingPresetId(presetId);
  if (!id) return null;
  return normalizePersistentMindThinkingPresets(raw).presets.find((preset) => preset.id === id) || null;
}


export const persistentMindThinkingRequestSchema = z.object({
  presetId: persistentMindThinkingPresetSchema.shape.id,
  reason: z.string().trim().min(1).max(200),
}).strict();

export const PERSISTENT_MIND_THINKING_LIMITS = Object.freeze({ maxPerRollingDay: 3, rollingWindowMs: 86_400_000, minGapMs: 1_800_000 });

const thinkingRequestRecordSchema = z.object({
  requestId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  at: z.string().datetime(),
  admittedAt: z.string().datetime().optional(),
  reason: z.string().max(200),
  selection: persistentMindThinkingSelectionSchema,
  outcome: z.enum(['pending', 'admitted', 'completed', 'failed', 'cancelled', 'interrupted']).optional(),
  grant: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function normalizePersistentMindThinkingRequest(value) {
  return thinkingRequestRecordSchema.safeParse(value).data || null;
}

export function normalizePersistentMindThinkingRequests(value) {
  return {
    pending: normalizePersistentMindThinkingRequest(value?.pending),
    history: (Array.isArray(value?.history) ? value.history : [])
      .map(normalizePersistentMindThinkingRequest).filter(Boolean).slice(-20),
  };
}
