import { trimTo } from './textUtils.js';

const CONTEXT_MAX = 6000;
const BIBLE_HEADER = 'Production bible (use the subjects relevant to this shot; preserve their identity; descriptions may be abbreviated):';

// The mood board describes a LOOK. Its snapshot can still carry the board's own
// subjects and places (image captions, or a synthesized style that pictures a
// street or a bathroom), so it is labelled look-only wherever it is included.
export const MOOD_BOARD_LOOK_LABEL = 'Mood board look (palette, lighting and texture only; never its locations, objects or poses)';

/**
 * Shared, bounded creative bible for planning, media generation and handoff.
 * `moodBoard: false` leaves the mood-board look out — a motion prompt is
 * conditioned on a reference frame that already carries the look, and the
 * board's pictured places and subjects only fight the shot there.
 */
export function musicVideoCreativeContext(concept, { moodBoard = true } = {}) {
  if (!concept) return '';
  const styles = [
    concept.universeStyle && `Universe style: ${trimTo(concept.universeStyle, 800)}`,
    moodBoard && concept.moodBoardStyle && `${MOOD_BOARD_LOOK_LABEL}: ${trimTo(concept.moodBoardStyle, 800)}`,
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
  // A procedural direction (castAndSetsDirection.js) carries how the cast is
  // built and moves in code and how the world behaves; the same lines reach
  // the planner and any code-authoring prompt that includes this context.
  const procedural = direction.medium === 'procedural';
  const w = direction.world || {};
  const lines = (label, pairs) => {
    const body = pairs.filter(([, v]) => v).map(([k, v]) => `${k}: ${trimTo(v, 300)}`).join('; ');
    return body ? [`${label} ${body}`] : [];
  };
  return [
    procedural
      ? 'Cast & Sets direction (authoritative characters, environments, motion and camera; characters and scenes are authored in code, never photographed):'
      : 'Cast & Sets direction (authoritative locations and wardrobe):',
    'The mood board is LOOK-ONLY: borrow palette, lighting and texture, never its literal locations, objects or narrative. Use the assigned set for each shot.',
    `Story: ${trimTo(direction.logline, 400)} ${trimTo(direction.interpretation, 600)}`,
    `Protagonist: ${[p.name, p.description, p.face, p.hair, p.signature, p.gesture, ...(p.rules || [])].filter(Boolean).map((s) => trimTo(s, 300)).join('; ')}`,
    ...(procedural ? lines('Character build:', [
      ['construction', p.construction], ['shape language', p.shapeLanguage], ['materials', p.materials], ['palette', p.palette],
      ['expressions', (p.expressions || []).join(' | ')], ['movement', p.movement],
    ]) : []),
    ...(procedural ? lines('World rules:', [
      ['layout', w.layout], ['depth', w.depth], ['lighting', w.lighting], ['camera', w.camera], ['transitions', w.transitions],
    ]) : []),
    ...((direction.looks || []).slice(0, 8).map((l) => `Look ${trimTo(l.name, 80)}: ${trimTo(l.description, 300)}; chapters: ${trimTo(l.chapters, 120)}`)),
    ...((direction.sets || []).slice(0, 8).map((s) => `Set ${trimTo(s.name, 80)}: ${trimTo(s.description, 300)}; lighting: ${trimTo(s.lighting, 120)}${procedural ? `; image role: ${s.imageRole || 'background'}` : ''}`)),
  ].join('\n').slice(0, 6000);
}

const CODE_CONTEXT_MAX = 8000;

/**
 * The approved procedural direction as a code-authoring request needs it: how
 * each character is built and moves, the world's layout/depth/lighting/camera/
 * transition rules, and the reusable character definitions (geometry, palette,
 * expressions, poses, motion) so every scene draws the same figures. '' for a
 * photographic direction or one with neither rules nor definitions. Whole
 * characters are included while the budget allows, never a truncated JSON.
 */
export function musicVideoCodeDirectionContext(direction) {
  if (direction?.medium !== 'procedural') return '';
  const p = direction.protagonist || {};
  const w = direction.world || {};
  const rules = (label, pairs) => {
    const body = pairs.filter(([, v]) => v).map(([k, v]) => `${k}: ${trimTo(v, 300)}`).join('; ');
    return body ? [`${label} ${body}`] : [];
  };
  const head = [
    'Approved Cast & Sets direction for code (reuse these exact definitions and rules in every scene; never redesign a character, palette or camera language per scene):',
    ...rules('Character build:', [['construction', p.construction], ['shape language', p.shapeLanguage], ['materials', p.materials], ['palette', p.palette], ['expressions', (p.expressions || []).join(' | ')], ['movement', p.movement]]),
    ...rules('World rules:', [['layout', w.layout], ['depth', w.depth], ['lighting', w.lighting], ['camera', w.camera], ['transitions', w.transitions]]),
    ...(direction.sets || []).slice(0, 8).map((s) => `Set ${trimTo(s.name, 80)} (image role ${s.imageRole || 'background'}): ${trimTo(s.description, 200)}`),
  ];
  const lines = [...head];
  const characters = direction.definitions?.characters || [];
  if (characters.length) {
    lines.push('Character definitions (JSON; coordinates are in a 200x200 box, origin top-left; expressions and poses override base parts; motion rules are per-beat):');
    let budget = CODE_CONTEXT_MAX - lines.join('\n').length;
    for (const character of characters) {
      const json = JSON.stringify(character);
      if (json.length > budget) break;
      lines.push(json);
      budget -= json.length + 1;
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}
