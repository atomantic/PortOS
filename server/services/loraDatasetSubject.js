/**
 * LoRA dataset subject derivation — the leaf both the captioner and the
 * generator import (issue #5917).
 *
 * `loraDatasetCaption.js` and `loraDatasetGenerate.js` each need the dataset's
 * live canon subject (generation/slicing render from current canon, captioning
 * derives its signature-feature deny-list from it). Those helpers used to live
 * in `loraDatasetGenerate.js`, which the captioner imported — while the
 * generator imported caption-model resolution back from the captioner, closing
 * a two-module static ESM cycle. They live here now: this module imports only
 * `universeBuilder.js` (which imports no `loraDataset*` module), so both
 * callers depend on the leaf and neither depends on the other.
 */

import { ServerError } from '../lib/errorHandler.js';
import { getUniverse } from './universeBuilder.js';

const trim = (s) => (typeof s === 'string' ? s.trim() : '');
export const normalizeEntryKind = (entryKind) => (
  ['characters', 'objects', 'places'].includes(entryKind) ? entryKind : 'characters'
);
export const subjectLabel = (entryKind) => {
  switch (normalizeEntryKind(entryKind)) {
    case 'objects': return 'Object';
    case 'places': return 'Place';
    default: return 'Character';
  }
};

export const flattenValue = (value) => {
  if (typeof value === 'string') return trim(value);
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === 'string') return trim(v);
      if (v && typeof v === 'object') return trim(v.name || v.label || v.description || v.prompt || '');
      return '';
    }).filter(Boolean).join(', ');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, v]) => `${key}: ${typeof v === 'string' ? trim(v) : trim(v?.name || v?.label || '')}`)
      .filter((part) => !part.endsWith(': '))
      .join(', ');
  }
  return '';
};

/**
 * Pull the subject's INVARIANT signature features — the wardrobe pieces, props,
 * and palette that are present in (nearly) every reference image and therefore
 * belong to the trigger token, not the per-shot caption. Returned as discrete
 * short phrases so the captioner can be told to omit them by name (issue #1320:
 * captioning "red cloak, woven crown, leather armor" in every shot binds the
 * look to those phrases instead of the trigger). Pure; tolerant of the bible's
 * looser object/place shape. Capped + de-duped so the deny-list stays focused.
 */
export function extractSubjectSignaturePhrases(subject, entryKind = 'characters') {
  if (!subject || typeof subject !== 'object') return [];
  const out = [];
  const pushNames = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const name = trim(item?.name);
      if (name) out.push(name);
    }
  };
  if (normalizeEntryKind(entryKind) === 'characters') {
    pushNames(subject.wardrobes);
    pushNames(subject.props);
    pushNames(subject.colorPalette);
  } else {
    // Objects/places: the recurring details + palette are the invariants. In the
    // looser object/place bible shape both can be a string OR an array, so route
    // them through flattenValue (handles both) rather than the array-only
    // pushNames — a string `palette` would otherwise be dropped entirely.
    for (const raw of [subject.colorPalette || subject.palette, subject.recurringDetails]) {
      const flat = flattenValue(raw);
      if (flat) out.push(...flat.split(',').map((p) => p.trim()));
    }
  }
  const visualIdentity = trim(subject.visualIdentity);
  if (visualIdentity) out.push(visualIdentity);
  const seen = new Set();
  return out
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, 12);
}

// Load the dataset's live canon subject (generation + slicing both need
// the current canon, not the dataset's snapshot). 409 when the subject
// was deleted from the universe after the dataset was created.
// Exported so the captioner can derive the subject's signature-feature
// deny-list without duplicating the universe/entry lookup.
export async function loadDatasetSubject(dataset) {
  const entryKind = normalizeEntryKind(dataset.character.entryKind);
  const universe = await getUniverse(dataset.character.universeId);
  const entries = Array.isArray(universe[entryKind]) ? universe[entryKind] : [];
  const subject = entries.find((entry) => entry.id === dataset.character.entryId);
  if (!subject) {
    throw new ServerError(
      `${subjectLabel(entryKind)} ${dataset.character.entryId} no longer exists in universe ${dataset.character.universeId}`,
      { status: 409, code: 'UNIVERSE_CANON_NOT_FOUND' },
    );
  }
  return { universe, subject: { ...subject, entryKind }, entryKind };
}
