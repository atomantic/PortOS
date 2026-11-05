/** The editable subject description shared by a music video and its catalog look. */
export const MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX = 1000;

/** An unchanged legacy description is allowed so unrelated catalog edits remain possible. */
export function changedMusicVideoDescriptionOverLimit(type, before = {}, after = {}) {
  const key = type === 'character' ? 'physicalDescription' : ['place', 'object'].includes(type) ? 'description' : null;
  if (!key) return null;
  const tooLong = (oldText, text) => typeof text === 'string' && text !== (oldText || '') && text.length > MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX;
  if (tooLong(before[key], after[key])) return { field: key, length: after[key].length };
  const oldForms = new Map((Array.isArray(before.forms) ? before.forms : []).filter((form) => form && typeof form === 'object').map((form) => [form.id, form]));
  for (const form of Array.isArray(after.forms) ? after.forms : []) {
    if (!form || typeof form !== 'object') continue;
    if (tooLong(oldForms.get(form.id)?.description, form.description)) return { field: 'forms', formId: form.id, length: form.description.length };
  }
  return null;
}
