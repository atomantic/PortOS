/** One active interpretation per named character; older projects choose the first. */
export function activeMusicVideoSubjects(concept) {
  const subjects = concept?.subjects || [];
  const chosen = new Map();
  for (const subject of subjects) {
    if (subject?.kind !== 'character' || subject.active === false) continue;
    const key = subject.name?.trim();
    if (!chosen.has(key) || (subject.active === true && chosen.get(key).active !== true)) chosen.set(key, subject);
  }
  return subjects.filter(subject => subject?.kind !== 'character' || chosen.get(subject.name?.trim()) === subject);
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
