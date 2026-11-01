import { GREYBOX_SHOT_ROLE_PREFIX, greyboxFigurePromptLines } from './greyboxVocabulary.js';

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
  const capture = plate || entry.media?.find((m) => sendable(m) && m.role === `${GREYBOX_SHOT_ROLE_PREFIX}${shot.id}`);
  if (!capture) return fail('the saved shot has no capture');
  return {
    reference: { id: `mvr-greybox-${shot.id}`, imageId: capture.mediaKey, role: 'set', label: `${subject.name} · ${shot.label}`, greybox: true, ...(plate ? { plate: true } : {}) },
    promptAdditions: greyboxFigurePromptLines(greybox, shot).map((text, i) => ({ id: `greybox-figure-${i}`, label: `Greybox figure ${i + 1}`, text })),
  };
}
