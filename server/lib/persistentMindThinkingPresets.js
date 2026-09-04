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

const sanitizePreset = (value) => {
  const id = asPersistentMindThinkingPresetId(value?.id);
  const providerId = text(value?.providerId, PERSISTENT_MIND_THINKING_PRESET_LIMITS.PROVIDER_ID_MAX);
  const model = text(value?.model, PERSISTENT_MIND_THINKING_PRESET_LIMITS.MODEL_MAX);
  // A preset without an exact route cannot be resolved without inventing one,
  // so it is dropped rather than stored as a half-pin.
  if (!id || !providerId || !model) return null;
  const effort = text(value?.effort, 20);
  return {
    id,
    label: text(value?.label, PERSISTENT_MIND_THINKING_PRESET_LIMITS.LABEL_MAX) || `${providerId} / ${model}`,
    providerId,
    model,
    effort: EFFORT_LEVELS.includes(effort) ? effort : '',
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
