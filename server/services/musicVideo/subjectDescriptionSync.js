import { ServerError } from '../../lib/errorHandler.js';
import { MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX } from '../../lib/musicVideoSubjectLimits.js';

const PRIMARY_KEY = { character: 'physicalDescription', place: 'description', object: 'description' };
const sameText = (a, b) => String(a || '') === String(b || '');

// Linked catalog text is the live value; the stored snapshot remains a fallback
// for a missing record, missing look, or an overlong legacy description.
export async function resolveProjectCatalogDescriptions(project, { client, catalogDB } = {}) {
  return (await resolveProjectsCatalogDescriptions([project], { client, catalogDB }))[0];
}

export async function resolveProjectsCatalogDescriptions(projects, { client, catalogDB } = {}) {
  const ids = projects.flatMap((project) => Array.isArray(project?.concept?.subjects) ? project.concept.subjects.map((subject) => subject?.ingredientId) : []).filter(Boolean);
  if (!ids.length) return projects;
  const catalog = catalogDB || await import('../catalogDB.js');
  const records = await catalog.getIngredientDescriptionsByRequestedIds(ids, { client });
  return projects.map((project) => {
    const subjects = project?.concept?.subjects;
    if (!Array.isArray(subjects)) return project;
    const resolved = subjects.map((subject) => {
      if (!subject || typeof subject !== 'object') return subject;
      const record = records.get(subject.ingredientId);
      if (!record || record.type !== subject.kind || !PRIMARY_KEY[subject.kind]) return subject;
      const payload = record.payload || {};
      const form = subject.castForm?.id && Array.isArray(payload.forms) ? payload.forms.find((item) => item.id === subject.castForm.id) : null;
      if (subject.castForm?.id && !form) return subject;
      const text = String(form ? form.description || '' : payload[PRIMARY_KEY[subject.kind]] || payload.description || '');
      return text.length <= MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX && text !== subject.description ? { ...subject, description: text } : subject;
    });
    return { ...project, concept: { ...project.concept, subjects: resolved } };
  });
}

// An unrelated project write must not erase an older stored snapshot merely
// because the live catalog value was read into the editable project.
export function preserveUnchangedDescriptionSnapshots(stored, resolved, edited, committedIds = []) {
  const originals = new Map((stored.concept?.subjects || []).filter(Boolean).map((subject) => [subject.id, subject]));
  const live = new Map((resolved.concept?.subjects || []).filter(Boolean).map((subject) => [subject.id, subject]));
  const commit = new Set(committedIds);
  const subjects = edited.concept?.subjects;
  if (!Array.isArray(subjects)) return edited;
  const restored = subjects.map((subject) => {
    if (!subject || typeof subject !== 'object') return subject;
    const original = originals.get(subject.id);
    const current = live.get(subject.id);
    if (!original?.ingredientId || commit.has(subject.id) || original.ingredientId !== subject.ingredientId
      || original.kind !== subject.kind || (original.castForm?.id || '') !== (subject.castForm?.id || '')
      || subject.description !== current?.description) return subject;
    const { description: _description, ...rest } = subject;
    return Object.hasOwn(original, 'description') ? { ...rest, description: original.description } : rest;
  });
  return { ...edited, concept: { ...edited.concept, subjects: restored } };
}

// Keep edits to an already-linked subject and its catalog description in the
// same transaction. A stale video must never overwrite a newer catalog edit.
export async function syncEditedSubjectDescriptions(before, after, { client, catalogDB, bases = [], includeNewLinks = false } = {}) {
  if (!client) return { project: after, records: [] };
  const previous = new Map((before.concept?.subjects || []).filter(Boolean).map((subject) => [subject.id, subject]));
  const baseById = new Map(bases.map((base) => [base.subjectId, base.description]));
  const groups = new Map();
  for (const subject of after.concept?.subjects || []) {
    if (!subject || typeof subject !== 'object') continue;
    const old = previous.get(subject.id);
    if (!subject.ingredientId || !PRIMARY_KEY[subject.kind]) continue;
    const sameLink = old?.ingredientId === subject.ingredientId && old.kind === subject.kind
      && (old.castForm?.id || '') === (subject.castForm?.id || '');
    if (!sameLink && !includeNewLinks) continue;
    if (sameLink && old.description === subject.description) continue;
    if ((subject.description || '').length > MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX) throw new ServerError('A video subject description holds at most 1,000 characters.', { status: 400, code: 'DESCRIPTION_TOO_LONG' });
    const base = baseById.get(subject.id);
    if (sameLink && (base === undefined || base !== (old.description || ''))) {
      throw new ServerError('The video description changed. Reload it before saving this edit.', { status: 409, code: 'CATALOG_DESCRIPTION_CONFLICT' });
    }
    const formId = subject.castForm?.id || '';
    if (!groups.has(subject.ingredientId)) groups.set(subject.ingredientId, new Map());
    const edits = groups.get(subject.ingredientId);
    const edit = { kind: subject.kind, formId, before: base, after: subject.description || '' };
    const other = edits.get(formId);
    if (other && (!sameText(other.before, edit.before) || other.after !== edit.after)) {
      throw new ServerError('Two subjects propose different descriptions for the same catalog look.', { status: 409, code: 'CATALOG_DESCRIPTION_CONFLICT' });
    }
    edits.set(formId, edit);
  }
  if (!groups.size) return { project: after, records: [] };
  const catalog = catalogDB || await import('../catalogDB.js');
  const changed = [];
  for (const [ingredientId, edits] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const record = await catalog.getIngredient(ingredientId, { client });
    if (!record || [...edits.values()].some((edit) => record.type !== edit.kind)) {
      throw new ServerError('A linked catalog record no longer exists or has changed type.', { status: 409, code: 'CATALOG_DESCRIPTION_CONFLICT' });
    }
    const result = await catalog.updateIngredientPayloadKeys(ingredientId, (payload) => {
      const patch = {};
      let forms = payload.forms;
      for (const edit of edits.values()) {
        const key = PRIMARY_KEY[edit.kind];
        const form = edit.formId && Array.isArray(forms) ? forms.find((item) => item.id === edit.formId) : null;
        if (edit.formId && !form) throw new ServerError('The linked catalog look no longer exists.', { status: 409, code: 'CATALOG_DESCRIPTION_CONFLICT' });
        const current = edit.formId ? form.description || '' : payload[key] || payload.description || '';
        const expected = edit.before === undefined ? edit.after : edit.before;
        if (!sameText(current, expected)) throw new ServerError('The catalog description changed. Review it before saving this video edit.', { status: 409, code: 'CATALOG_DESCRIPTION_CONFLICT' });
        if (!edit.formId && edit.kind === 'character' && !edit.after && payload.description) {
          throw new ServerError('Clear the catalog record’s fallback description before clearing this linked description.', { status: 409, code: 'CATALOG_DESCRIPTION_CONFLICT' });
        }
        if (edit.formId) forms = forms.map((item) => item.id === edit.formId ? { ...item, description: edit.after } : item);
        else patch[key] = edit.after;
      }
      if ([...edits.keys()].some(Boolean)) patch.forms = forms;
      return patch;
    }, { client, invalidateEmbedding: true });
    if (!result) throw new ServerError('A linked catalog record no longer exists.', { status: 409, code: 'CATALOG_DESCRIPTION_CONFLICT' });
    changed.push(result.ingredient);
  }
  return { project: after, records: changed };
}

export async function announceDescriptionEdits(records) {
  if (!records.length) return;
  const [{ catalogEvents }, { projectToCanon }] = await Promise.all([import('../catalogEvents.js'), import('../catalogCanonProjection.js')]);
  for (const record of records) {
    catalogEvents.emit('primitive-changed', { ingredientId: record.id });
    await projectToCanon(record.id, record).catch((err) => console.error(`🔁 catalog→canon projection failed for ${record.id}: ${err.message}`));
  }
}
