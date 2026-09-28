/** Shared creative bible for planning, local media generation and external handoff. */
export function musicVideoCreativeContext(concept) {
  if (!concept) return '';
  const subjects = (concept.subjects || []).map((s) =>
    `${s.kind}${s.kind === 'character' && s.role ? ` (${s.role})` : ''}: ${s.name}${s.description ? ` — ${s.description}` : ''}`);
  return [
    concept.universeStyle && `Universe style: ${concept.universeStyle}`,
    concept.moodBoardStyle && `Mood board style: ${concept.moodBoardStyle}`,
    subjects.length && `Production bible (use the subjects relevant to this shot; preserve their identity):\n${subjects.join('\n')}`,
  ].filter(Boolean).join('\n');
}
