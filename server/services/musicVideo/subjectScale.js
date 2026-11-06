// The real-world sizes of a music video's subjects, read live from their
// catalog records (a person's height, a place's or object's `size`), in the
// `{ [subjectId]: text }` shape musicVideoSubjectScaleText takes. A subject not
// linked to the catalog takes its Cast & Sets height by name.

import { activeMusicVideoSubjects } from '../../lib/musicVideoCastSelection.js';
import { characterHeightStat } from '../../lib/catalogAppearance.js';
import { resolveHeight } from '../../lib/characterHeight.js';

const nameKey = (value) => String(value || '').trim().toLowerCase();
// "5 ft 1 in tall" reads "… tall tall" once the line adds its own.
const withoutTall = (text) => String(text || '').trim().replace(/\s+tall\.?$/i, '');

function characterSize(payload, castFormId) {
  const form = castFormId && Array.isArray(payload.forms) ? payload.forms.find((f) => f?.id === castFormId) : null;
  // A look, or an adult age, with no height of its own keeps the record's (as its sheet does).
  const fromForm = form ? resolveHeight(form.height, form.age) : null;
  const height = fromForm?.text ? fromForm : resolveHeight(characterHeightStat(payload), payload.age);
  return height?.text || '';
}

function directionHeights(project) {
  const direction = project?.castAndSets?.direction;
  const out = new Map();
  if (direction?.protagonist?.name && direction.protagonist.height) out.set(nameKey(direction.protagonist.name), direction.protagonist.height);
  for (const c of Array.isArray(direction?.cast) ? direction.cast : []) {
    if (c?.name && c.height) out.set(nameKey(c.name), c.height);
  }
  return out;
}

/**
 * `{ [subjectId]: size }` for the project's active subjects that state one. A
 * record that fails to load is skipped: the shot renders without its size.
 */
export async function loadMusicVideoSubjectSizes(project, deps = {}) {
  const subjects = activeMusicVideoSubjects(project?.concept);
  if (!subjects.length) return {};
  const linked = subjects.filter((s) => s.ingredientId);
  const catalog = linked.length ? deps.catalog || await import('../catalogDB.js') : null;
  const records = new Map();
  const load = (id) => {
    if (!records.has(id)) {
      records.set(id, Promise.resolve().then(() => catalog.getIngredient(id)).catch((err) => {
        console.warn(`⚠️ Shot scale: catalog record ${id} unavailable: ${err.message}`);
        return null;
      }));
    }
    return records.get(id);
  };
  const fallback = directionHeights(project);
  const out = {};
  await Promise.all(subjects.map(async (subject) => {
    const record = subject.ingredientId ? await load(subject.ingredientId) : null;
    const payload = record && !record.deleted && record.type === subject.kind ? record.payload || {} : null;
    // A person's line adds its own "tall"; a size says what it measures.
    const text = subject.kind === 'character'
      ? withoutTall((payload ? characterSize(payload, subject.castForm?.id) : '') || fallback.get(nameKey(subject.name)))
      : String(payload && typeof payload.size === 'string' ? payload.size : '').trim();
    if (text) out[subject.id] = text;
  }));
  return out;
}
