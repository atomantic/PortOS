/**
/**
 * Retained LoRA training dataset records — pure sanitizers (no I/O).
 *
 * Training is retired (#13536); retained records under
 * `data/lora-datasets/<id>/index.json` must keep loading, so the record
 * sanitizer fed to collectionStore stays. Dataset I/O is in
 * `server/services/loraDatasets.js`.
 */

import { isPlainObject } from './objects.js';

export const LORA_DATASET_SCHEMA_VERSION = 1;

export const LORA_DATASET_ENTRY_KINDS = Object.freeze(['characters', 'objects', 'places']);
export const DATASET_IMAGE_SOURCES = Object.freeze(['generated', 'upload', 'refsheet-slice', 'gallery']);
export const DATASET_IMAGE_STATUSES = Object.freeze(['rendering', 'ready', 'failed']);
export const DATASET_STATUSES = Object.freeze(['draft', 'training', 'trained']);
export const CAPTION_SOURCES = Object.freeze(['vision', 'manual']);

const TRIGGER_WORD_RE = /^[a-z0-9_]{2,64}$/;
export const isValidTriggerWord = (word) => typeof word === 'string' && TRIGGER_WORD_RE.test(word);

const trim = (s) => (typeof s === 'string' ? s.trim() : '');
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const isoOrNull = (v) => (typeof v === 'string' && v ? v : null);

/**
 * Sanitize one dataset image entry. Returns null for entries with no id or
 * file (unrecoverable). Captions clamp to 2000 chars to match the route's
 * Zod bound so a hand-edited record can't smuggle an oversized caption past
 * validation.
 */
export function sanitizeDatasetImage(raw) {
  if (!isPlainObject(raw)) return null;
  const id = trim(raw.id);
  const file = trim(raw.file);
  if (!id || !file) return null;
  const variation = isPlainObject(raw.variation)
    ? {
      view: trim(raw.variation.view) || null,
      pose: trim(raw.variation.pose) || null,
      expression: trim(raw.variation.expression) || null,
      outfit: trim(raw.variation.outfit) || null,
    }
    : null;
  return {
    id,
    file,
    caption: trim(raw.caption).slice(0, 2000),
    captionSource: oneOf(raw.captionSource, CAPTION_SOURCES, null),
    captionedAt: isoOrNull(raw.captionedAt),
    source: oneOf(raw.source, DATASET_IMAGE_SOURCES, 'upload'),
    sourceJobId: trim(raw.sourceJobId) || null,
    variation,
    status: oneOf(raw.status, DATASET_IMAGE_STATUSES, 'ready'),
    width: Number.isInteger(raw.width) && raw.width > 0 ? raw.width : null,
    height: Number.isInteger(raw.height) && raw.height > 0 ? raw.height : null,
    createdAt: isoOrNull(raw.createdAt),
  };
}

/**
 * Record-level sanitizer fed to collectionStore — runs on every loadOne.
 * Returns null when the record is missing its identity (id or character),
 * which collectionStore treats as "invalid record".
 */
export function sanitizeLoraDataset(raw) {
  if (!isPlainObject(raw)) return null;
  const id = trim(raw.id);
  const character = isPlainObject(raw.character) ? raw.character : null;
  if (!id || !character) return null;
  const entryId = trim(character.entryId);
  const universeId = trim(character.universeId);
  if (!entryId || !universeId) return null;
  const training = isPlainObject(raw.training) ? raw.training : {};
  return {
    schemaVersion: LORA_DATASET_SCHEMA_VERSION,
    id,
    character: {
      entryId,
      entryKind: oneOf(character.entryKind, LORA_DATASET_ENTRY_KINDS, 'characters'),
      ingredientId: trim(character.ingredientId) || null,
      universeId,
      name: trim(character.name) || 'Unnamed',
    },
    triggerWord: isValidTriggerWord(raw.triggerWord) ? raw.triggerWord : '',
    status: oneOf(raw.status, DATASET_STATUSES, 'draft'),
    images: Array.isArray(raw.images) ? raw.images.map(sanitizeDatasetImage).filter(Boolean) : [],
    training: {
      lastJobId: trim(training.lastJobId) || null,
      lastRunId: trim(training.lastRunId) || null,
      loraFilename: trim(training.loraFilename) || null,
      completedAt: isoOrNull(training.completedAt),
    },
    createdAt: isoOrNull(raw.createdAt),
    updatedAt: isoOrNull(raw.updatedAt),
  };
}
