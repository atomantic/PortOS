import { trimTo } from './textUtils.js';

const CONTEXT_MAX = 6000;
const BIBLE_HEADER = 'Production bible (use the subjects relevant to this shot; preserve their identity; descriptions may be abbreviated):';

/** Shared, bounded creative bible for planning, media generation and handoff. */
export function musicVideoCreativeContext(concept) {
  if (!concept) return '';
  const styles = [
    concept.universeStyle && `Universe style: ${trimTo(concept.universeStyle, 800)}`,
    concept.moodBoardStyle && `Mood board style: ${trimTo(concept.moodBoardStyle, 800)}`,
  ].filter(Boolean);
  const subjects = (concept.subjects || []).slice(0, 24);
  const identities = subjects.map((s) =>
    `${s.kind}${s.kind === 'character' && s.role ? ` (${s.role})` : ''}: ${trimTo(s.name, 120)}`);
  // Reserve every identity first; share the remaining description budget so
  // a large cast cannot crowd later characters out of the prompt entirely.
  const fixedSize = styles.join('\n').length + BIBLE_HEADER.length + identities.join('\n').length + 4;
  const descriptionLimit = subjects.length
    ? Math.max(0, Math.min(300, Math.floor((CONTEXT_MAX - fixedSize) / subjects.length) - 3)) : 0;
  const lines = subjects.map((subject, i) => {
    const description = trimTo(subject.description, descriptionLimit);
    return `${identities[i]}${description ? ` — ${description}` : ''}`;
  });
  return [...styles, ...(lines.length ? [BIBLE_HEADER, ...lines] : [])].join('\n').slice(0, CONTEXT_MAX);
}

/** Bounded Cast & Sets bible; mood-board subjects are never location authority. */
export function musicVideoDirectionContext(direction) {
  if (!direction) return '';
  const p = direction.protagonist || {};
  return [
    'Cast & Sets direction (authoritative locations and wardrobe):',
    'The mood board is LOOK-ONLY: borrow palette, lighting and texture, never its literal locations, objects or narrative. Use the assigned set for each shot.',
    `Story: ${trimTo(direction.logline, 400)} ${trimTo(direction.interpretation, 600)}`,
    `Protagonist: ${[p.name, p.description, p.face, p.hair, p.signature, p.gesture, ...(p.rules || [])].filter(Boolean).map((s) => trimTo(s, 300)).join('; ')}`,
    ...((direction.looks || []).slice(0, 8).map((l) => `Look ${trimTo(l.name, 80)}: ${trimTo(l.description, 300)}; chapters: ${trimTo(l.chapters, 120)}`)),
    ...((direction.sets || []).slice(0, 8).map((s) => `Set ${trimTo(s.name, 80)}: ${trimTo(s.description, 300)}; lighting: ${trimTo(s.lighting, 120)}`)),
  ].join('\n').slice(0, 6000);
}
