/** One active interpretation per named character; older projects choose the first. */
export function activeMusicVideoSubjects(concept) {
  const subjects = concept?.subjects || [];
  const chosen = new Map();
  for (const subject of subjects) {
    if (subject?.kind !== 'character' || subject.active === false) continue;
    const key = subject.name?.trim();
    if (!key) continue;
    if (!chosen.has(key) || (subject.active === true && chosen.get(key).active !== true)) chosen.set(key, subject);
  }
  return subjects.filter(subject => subject?.kind !== 'character'
    || (subject.active !== false && (!subject.name?.trim() || chosen.get(subject.name.trim()) === subject)));
}

/** References with an identifiable inactive owner cannot condition a new render. */
export function isActiveMusicVideoReference(project, reference) {
  const subjects = project?.concept?.subjects || [];
  const active = activeMusicVideoSubjects(project?.concept);
  const cast = project?.castAndSets?.direction?.cast?.find(entry =>
    reference.id === `mvr-cs-cast-${entry.id}`.slice(0, 64) || reference.id === `mvr-cs-face-${entry.id}`.slice(0, 64));
  const owner = (reference.catalogSubjectId && subjects.find(subject => subject.id === reference.catalogSubjectId))
    || (['mvr-cs-character', 'mvr-cs-expressions'].includes(reference.id)
      && subjects.find(subject => subject.id === 'cs-protagonist' || (subject.kind === 'character' && subject.role === 'protagonist')))
    || (cast && subjects.find(subject => subject.id === cast.id || subject.id === `cs-cast-${cast.id}`.slice(0, 64)));
  if (owner) return active.includes(owner);
  const items = (project?.castAndSets?.catalogCheckin?.items || []).filter(item => item.images?.includes(reference.imageId));
  if (items.length) {
    return items.some(item => !subjects.some(subject => subject.id === item.subjectId)
      || active.some(subject => subject.id === item.subjectId));
  }
  if (reference.ingredientId && subjects.some(subject => subject.ingredientId === reference.ingredientId)) {
    return active.some(subject => subject.ingredientId === reference.ingredientId);
  }
  return true;
}

/**
 * The ids of the concept subjects a reference image shows: its catalog subject,
 * the Cast & Sets subject its generated sheet or plate was made for, or the
 * catalog-linked subject its image or ingredient belongs to. [] when the image
 * names no subject (a director's own upload, a mood image, a storyboard sketch).
 */
export function musicVideoReferenceSubjectIds(project, reference) {
  if (!reference) return [];
  const subjects = project?.concept?.subjects || [];
  const known = (ids) => [...new Set(ids)].filter((id) => subjects.some((subject) => subject.id === id));
  const direct = [reference.catalogSubjectId, reference.subjectId].filter(Boolean);
  if (direct.length) return known(direct);
  const id = String(reference.id || '');
  if (['mvr-cs-character', 'mvr-cs-expressions'].includes(id)) {
    return known(subjects.filter((subject) => subject.id === 'cs-protagonist' || (subject.kind === 'character' && subject.role === 'protagonist')).map((subject) => subject.id));
  }
  if (id === 'mvr-cs-props') return known(subjects.filter((subject) => subject.kind === 'object' && String(subject.id).startsWith('cs-prop-')).map((subject) => subject.id));
  const cast = project?.castAndSets?.direction?.cast?.find((entry) =>
    id === `mvr-cs-cast-${entry.id}`.slice(0, 64) || id === `mvr-cs-face-${entry.id}`.slice(0, 64));
  if (cast) return known([cast.id, `cs-cast-${cast.id}`.slice(0, 64)]);
  const set = project?.castAndSets?.direction?.sets?.find((entry) => id === `mvr-cs-set-${entry.id}`.slice(0, 64));
  if (set) return known([`cs-set-${set.id}`.slice(0, 64)]);
  const items = (project?.castAndSets?.catalogCheckin?.items || []).filter((item) => item.images?.includes(reference.imageId));
  if (items.length) return known(items.map((item) => item.subjectId));
  if (reference.ingredientId) return known(subjects.filter((subject) => subject.ingredientId === reference.ingredientId).map((subject) => subject.id));
  return [];
}
