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

/**
 * The project's previz (`project.previz`) as the active cast sees it: every id of
 * a character's unused alternate (a cast entry with the same name) reads as the
 * active one, and characters with no active entry drop out of the night's beats.
 * Lets the director switch alternates without re-blocking. Tracks, pawn colors
 * and beat casts keep the active entry's own data when both exist. Cached per
 * previz and cast, so playback can call it every frame.
 */
const PREVIZ_FOR_CAST = new WeakMap();
export function musicVideoPrevizForActiveCast(project) {
  const previz = project?.previz;
  if (!previz || typeof previz !== 'object') return null;
  const subjects = project?.concept?.subjects || [];
  const cached = PREVIZ_FOR_CAST.get(previz);
  if (cached && cached.subjects === subjects) return cached.value;
  const active = activeMusicVideoSubjects(project?.concept).filter((subject) => subject.kind === 'character');
  const byName = new Map(active.map((subject) => [subject.name?.trim(), subject.id]));
  const remap = new Map(subjects
    .filter((subject) => subject?.kind === 'character' && !active.includes(subject) && byName.has(subject.name?.trim()))
    .map((subject) => [subject.id, byName.get(subject.name.trim())]));
  let value = previz;
  if (remap.size) {
    const id = (subjectId) => remap.get(subjectId) || subjectId;
    const ids = (list) => (Array.isArray(list) ? [...new Set(list.map(id))] : list);
    const ownFirst = (entries, keyOf) => {
      const seen = new Set();
      return [...entries.filter((entry) => !remap.has(entry.subjectId)), ...entries.filter((entry) => remap.has(entry.subjectId))]
        .map((entry) => ({ ...entry, subjectId: id(entry.subjectId) }))
        .filter((entry) => !seen.has(keyOf(entry)) && seen.add(keyOf(entry)));
    };
    const pawnColors = previz.pawnColors && Object.fromEntries(Object.entries(previz.pawnColors)
      .sort(([a], [b]) => Number(remap.has(b)) - Number(remap.has(a)))
      .map(([subjectId, colors]) => [id(subjectId), colors]));
    value = {
      ...previz,
      cuts: (previz.cuts || []).map((cut) => ({
        ...cut,
        ...(cut.holderSubjectId ? { holderSubjectId: id(cut.holderSubjectId) } : {}),
        ...(cut.aimSubjectId ? { aimSubjectId: id(cut.aimSubjectId) } : {}),
        ...(Array.isArray(cut.visibleSubjectIds) ? { visibleSubjectIds: ids(cut.visibleSubjectIds) } : {}),
      })),
      tracks: ownFirst(previz.tracks || [], (track) => `${track.placeSubjectId}\u0000${track.subjectId}`),
      ...(pawnColors ? { pawnColors } : {}),
      ...(previz.night ? { night: { ...previz.night, beats: (previz.night.beats || []).map((beat) => ({ ...beat, subjectIds: ids(beat.subjectIds) })) } } : {}),
    };
  }
  PREVIZ_FOR_CAST.set(previz, { subjects, value });
  return value;
}
