import { trimTo } from './textUtils.js';

const CONTEXT_MAX = 6000;
const BIBLE_HEADER = 'Production bible (use the subjects relevant to this shot; preserve their identity; descriptions may be abbreviated):';

// The mood board describes a LOOK. Its snapshot can still carry the board's own
// subjects and places (image captions, or a synthesized style that pictures a
// street or a bathroom), so it is labelled look-only wherever it is included.
export const MOOD_BOARD_LOOK_LABEL = 'Mood board look (palette, lighting and texture only; never its locations, objects or poses)';

const PERSON = /\b(she|he|her|hers|him|his|they|them|their|woman|women|man|men|girl|boy|person|people|figure|figures|silhouette|someone|somebody|protagonist|character|singer|drummer|dancer)\b/i;

/**
 * `text` without the sentences or `;` clauses that describe a person (or
 * `name`). A mood board's pictured people (an image caption, a synthesized
 * style that poses a woman at a window) never reach a prompt as a subject.
 * `Avoid:` lines are kept: naming people there only keeps them out.
 */
export function withoutPeople(text, name = '') {
  const who = String(name || '').trim().toLowerCase();
  const keep = (part) => part.trim() && !PERSON.test(part) && !(who.length >= 3 && part.toLowerCase().includes(who));
  return String(text || '').split('\n')
    .map((line) => (/^\s*avoid:/i.test(line) ? line.trim() : line.split(/;\s*/)
      .map((clause) => clause.split(/(?<=[.!?])\s+/).filter(keep).join(' ').trim())
      .filter(Boolean).join('; ')))
    .filter(Boolean).join('\n');
}

/**
 * The director-written look (palette, light, film stock, texture) from the
 * project's Cast & Sets direction; '' when Cast & Sets was skipped or has none.
 */
export function musicVideoDirectorLook(project) {
  if (project?.castAndSets?.status === 'skipped') return '';
  return trimTo(project?.castAndSets?.direction?.look, 500) || '';
}

// A shot needs the character's identity, look, rules and never-list; the
// wardrobe catalogue is for Cast & Sets, which reads the full snapshot.
const characterStyleForShots = (snapshot) => snapshot.split('\n').filter((line) => !line.startsWith('Wardrobe options:')).join('\n');

/**
 * Shared, bounded creative bible for planning, media generation and handoff.
 * `moodBoard: false` leaves the look out — a motion prompt is conditioned on a
 * reference frame that already carries the look, and the board's pictured
 * places and subjects only fight the shot there. `look` is the director-written
 * look (musicVideoDirectorLook); when set it replaces the mood board snapshot.
 * Either way, sentences that picture a person are dropped.
 */
export function musicVideoCreativeContext(concept, { moodBoard = true, look = '' } = {}) {
  if (!concept) return '';
  const directorLook = withoutPeople(look);
  const boardLook = directorLook ? '' : withoutPeople(trimTo(concept.moodBoardStyle, 800));
  const sameAsStyle = directorLook && directorLook === withoutPeople(trimTo(concept.style, 500));
  const styles = [
    concept.characterStyle && `Character style (fixed identity; use the identity text verbatim): ${trimTo(characterStyleForShots(concept.characterStyle), 1900)}`,
    concept.universeStyle && `Universe style: ${trimTo(concept.universeStyle, 800)}`,
    moodBoard && directorLook && !sameAsStyle && `Look (palette, light and texture only): ${directorLook}`,
    moodBoard && boardLook && `${MOOD_BOARD_LOOK_LABEL}: ${boardLook}`,
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

// Suno writes an excluded style as a leading minus; people type it as a
// hyphen, a non-breaking hyphen (U+2011), an en dash or a minus sign.
const EXCLUDED_STYLE = /^[-\u2010\u2011\u2012\u2013\u2212]\s*/;

/**
 * Split a Suno style prompt into what the song sounds like and the styles it
 * excludes (`-bubblegum pop`). Terms are comma separated; '' and [] when unset.
 */
function parseSongStyle(text) {
  const terms = String(text || '').split(',').map((t) => t.trim()).filter(Boolean);
  const sound = terms.filter((t) => !EXCLUDED_STYLE.test(t));
  const avoid = terms.filter((t) => EXCLUDED_STYLE.test(t)).map((t) => t.replace(EXCLUDED_STYLE, '').trim()).filter(Boolean);
  return { sound: sound.join(', '), avoid };
}

/**
 * The song's own style (the Suno prompt it was made from) as direction for an
 * LLM that designs the picture. Music words are translated, never pasted into
 * an image prompt; the excluded styles name what the picture must not feel
 * like. '' when the project has no song style.
 */
export function musicVideoSongStyleContext(concept) {
  const { sound, avoid } = parseSongStyle(concept?.songStyle);
  if (!sound && !avoid.length) return '';
  return [
    'SONG STYLE (the Suno style prompt this song was made from). Let it shape the design of the world, the cast and the scenes together with the lyrics and the director\'s direction: translate its era, genre, energy, instrumentation and vocal character into period, wardrobe, locations, palette, lighting, camera movement and performance. Never copy these music words into an image or video prompt. A fixed character style still decides who the protagonist is; the song style only informs the protagonist\'s looks and the world around them.',
    sound && `Sound: ${trimTo(sound, 1500)}`,
    avoid.length && `The song deliberately avoids: ${trimTo(avoid.join(', '), 800)}. Keep the picture clear of their visual equivalents too: a song that avoids "cutesy" gets no cute design.`,
  ].filter(Boolean).join('\n');
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
