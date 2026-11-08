import { GREYBOX_SHOT_ROLE_PREFIX, greyboxFigurePromptLines, greyboxInfrastructurePromptLines } from './greyboxVocabulary.js';

/** Older records only have the flag; compare live captures when available and otherwise keep the gate. */
export function castAndSetsPendingGreyboxSetIds(stage, liveCaptures = {}) {
  if (!stage?.greyboxPending) return [];
  const direct = Array.isArray(stage.greyboxPendingSetIds) ? stage.greyboxPendingSetIds : [];
  const legacy = Array.isArray(stage.greyboxLegacyPendingSetIds) ? stage.greyboxLegacyPendingSetIds
    : Array.isArray(stage.greyboxPendingSetIds) ? [] : (stage.direction?.sets || []).map((set) => set.id);
  const candidates = new Set(legacy);
  const unresolved = (stage.direction?.sets || []).filter((set) => {
    if (!candidates.has(set.id)) return false;
    const chosen = set.setReference;
    const plan = stage.plan?.[`set:${set.id}`];
    const rendered = plan?.setReference;
    if (!chosen?.greyboxShotId && !rendered?.greyboxShotId) return false;
    return !chosen?.greyboxShotId || chosen.subjectId !== rendered?.subjectId || chosen.greyboxShotId !== rendered?.greyboxShotId
      || !liveCaptures[set.id] || liveCaptures[set.id] !== plan?.refImages?.[0];
  }).map((set) => set.id);
  return [...new Set([...direct, ...unresolved])];
}

export const castAndSetsGreyboxPending = (stage, liveCaptures) => castAndSetsPendingGreyboxSetIds(stage, liveCaptures).length > 0;

/** The greybox images a render sends, plate (or capture) first, then the optional blocking layout. */
export const musicVideoGreyboxReferences = (greybox) => [greybox?.reference, greybox?.blocking].filter(Boolean);

/** Resolve only the explicitly selected camera, never a replacement plate. Browser-safe. */
export function musicVideoGreyboxReference(project, scene, places = {}) {
  const selected = scene?.setReference;
  if (!selected?.greyboxShotId) return null;
  const subject = project?.concept?.subjects?.find((s) => s.id === selected.subjectId && s.kind === 'place');
  const entry = subject?.ingredientId && places[subject.ingredientId];
  const fail = (detail) => ({ error: `Greybox reference: ${detail}. Choose another saved shot or clear the selection.` });
  if (!subject?.ingredientId) return fail('the catalog set is no longer linked');
  if (!entry) return fail('the set could not be loaded');
  const place = entry.ingredient;
  if (place?.type !== 'place') return fail('the place is no longer available');
  const greybox = place.payload?.greybox;
  const shot = Array.isArray(greybox?.shots) && greybox.shots.find((s) => s.id === selected.greyboxShotId);
  if (!shot) return fail('the saved camera shot was removed');
  const sendable = (m) => !m.deleted && m.kind === 'reference' && /^[^/\\]+\.(png|jpe?g|webp)$/i.test(m.mediaKey);
  // The camera's finished photo plate wins over its flat capture; a plate no longer attached falls back.
  const plate = shot.plate && entry.media?.find((m) => sendable(m) && m.mediaKey === shot.plate);
  const flat = entry.media?.find((m) => sendable(m) && m.role === `${GREYBOX_SHOT_ROLE_PREFIX}${shot.id}`);
  const capture = plate || flat;
  if (!capture) return fail('the saved shot has no capture');
  const label = `${subject.name} · ${shot.label}`;
  // Behind a plate, the flat capture still shows where the camera's figures stand
  // and which way they face. On unless the shot turns it off (`blocking: false`).
  const blockingAvailable = Boolean(plate && flat) && Array.isArray(shot.figures) && shot.figures.length > 0;
  const blocking = blockingAvailable && selected.blocking !== false
    ? { id: `mvr-greybox-blocking-${shot.id}`, imageId: flat.mediaKey, role: 'blocking', label: `${label} blocking`, greybox: true, blocking: true }
    : null;
  return {
    reference: { id: `mvr-greybox-${shot.id}`, imageId: capture.mediaKey, role: 'set', label, greybox: true, ...(plate ? { plate: true } : {}) },
    ...(blocking ? { blocking } : {}),
    blockingAvailable,
    promptAdditions: [
      ...greyboxFigurePromptLines(greybox, shot).map((text, i) => ({ id: `greybox-figure-${i}`, label: `Greybox figure ${i + 1}`, text })),
      ...greyboxInfrastructurePromptLines(greybox, shot).map((text, i) => ({ id: `greybox-street-${i}`, label: `Greybox street ${i + 1}`, text })),
    ],
  };
}
