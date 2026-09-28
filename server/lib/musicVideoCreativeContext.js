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
