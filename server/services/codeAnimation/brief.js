/**
 * Code Animation brief writer (pure).
 *
 * The sibling of `prompt.js`: where that one asks a model to CODE the film,
 * this one asks a model to WRITE the film — a title, what happens, the
 * on-screen text beats, and any style refinement — from the universe the user
 * picked, exactly as the series/story surfaces do. The universe's narrative
 * bible (logline, premise, style notes) and its canon cast/places/objects are
 * the source material, so a generated brief stars the world's own characters
 * in its own locations instead of inventing a parallel one.
 *
 * Text prompt, not an image prompt: free-text `styleNotes` belongs here (see
 * `lib/universeVisualStyle.js` for why the image side excludes it).
 *
 * Deterministic string assembly over already-resolved inputs — loading the
 * universe and board happens in `index.js`.
 */

import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';
import { extractJson } from '../../lib/jsonExtract.js';
import { ServerError } from '../../lib/errorHandler.js';
import { CODE_ANIMATION_LIMITS, moodBoardSection } from './prompt.js';

export const CODE_ANIMATION_BRIEF_LIMITS = Object.freeze({
  seedIdeaMax: 2_000,
  charactersMax: 10,
  placesMax: 6,
  objectsMax: 6,
  fieldMax: 600,
});

const B = CODE_ANIMATION_BRIEF_LIMITS;

// The canon fields a 20-second animated film can actually act on: who someone
// is, what they look like, what they want. Deliberately narrower than the
// bible's full prompt-field set (`lib/storyBible.js#PROMPT_FIELDS`) — psychology
// sliders, wardrobes, and relationship graphs would swamp the prompt without
// changing a single frame.
const CANON_FIELDS = Object.freeze({
  characters: ['role', 'physicalDescription', 'visualNotes', 'personality', 'motivations', 'coreTheme'],
  places: ['description', 'palette', 'timeOfDay', 'recurringDetails'],
  objects: ['description', 'significance'],
});

const stringField = (value) => {
  if (Array.isArray(value)) return trimTo(value.filter(isNonBlankStr).join(', '), B.fieldMax);
  return isNonBlankStr(value) ? trimTo(value, B.fieldMax) : '';
};

/**
 * Project one canon kind down to the named-entity lines the brief writer reads.
 * Entries with nothing but a name still make the list — the writer needs to
 * know the world HAS them.
 */
export function projectCanonForBrief(entries, kind, cap) {
  const fields = CANON_FIELDS[kind] || [];
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => isNonBlankStr(entry?.name))
    .slice(0, cap)
    .map((entry) => {
      const projected = { name: trimTo(entry.name, 120) };
      for (const field of fields) {
        const value = stringField(entry[field]);
        if (value) projected[field] = value;
      }
      return projected;
    });
}

const canonBlock = (heading, rows) => {
  if (!rows.length) return '';
  const lines = rows.map((row) => {
    const { name, ...rest } = row;
    const detail = Object.entries(rest).map(([key, value]) => `${key}: ${value}`).join('; ');
    return detail ? `- ${name} — ${detail}` : `- ${name}`;
  });
  return `${heading}\n${lines.join('\n')}`;
};

function universeSection(universe) {
  if (!universe) return '';
  const lines = [`The film is set in the universe "${universe.name}". Everything you write must be canon to it.`];
  if (isNonBlankStr(universe.logline)) lines.push(`Logline: ${universe.logline}`);
  if (isNonBlankStr(universe.premise)) lines.push(`Premise: ${universe.premise}`);
  if (universe.embrace?.length) lines.push(`Visual style to embrace: ${universe.embrace.join(', ')}`);
  if (universe.avoid?.length) lines.push(`Visual style to avoid: ${universe.avoid.join(', ')}`);
  if (isNonBlankStr(universe.styleNotes)) lines.push(`Tone, staging, and pacing notes: ${universe.styleNotes}`);
  if (universe.styleReferences?.length) {
    lines.push('Style references curated for this universe:');
    lines.push(universe.styleReferences.map((ref) => `- ${ref.title ? `${ref.title}: ` : ''}${ref.prompt}`).join('\n'));
  }
  return lines.join('\n');
}

function castSection(universe) {
  const blocks = [
    canonBlock('CHARACTERS (cast the film from these — use their names):', universe?.characters || []),
    canonBlock('PLACES (stage the film in these):', universe?.places || []),
    canonBlock('OBJECTS that matter in this world:', universe?.objects || []),
  ].filter(Boolean);
  if (!blocks.length) {
    return universe
      ? 'This universe has no canon characters, places, or objects recorded yet — invent ones that fit its logline and tone, and keep the cast small.'
      : '';
  }
  return `${blocks.join('\n\n')}\n\nPrefer the canon above over inventing new entities. A character you use must behave, speak, and look as their entry describes.`;
}

function currentSection(current) {
  const rows = [
    ['Title', current.title],
    ['What happens', current.concept],
    ['On-screen text', current.onScreenText],
    ['Style refinements', current.styleNotes],
  ].filter(([, value]) => isNonBlankStr(value));
  if (!rows.length) return '';
  return `WHAT THE ARTIST HAS WRITTEN SO FAR — build on this rather than discarding it; keep what already works and fill in or sharpen the rest:\n${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}`;
}

/**
 * Build the prompt that asks a model to write an animation brief.
 *
 * @param {object} input
 * @param {object|null} [input.universe] - `{ name, logline, premise, embrace, avoid, styleNotes, styleReferences, characters, places, objects }`
 * @param {object|null} [input.moodBoard] - `collectBoardStyleContext` output
 * @param {string} [input.seedIdea] - the artist's starting spark, if any
 * @param {{ durationSeconds: number, aspectRatio: string }} input.format
 * @param {{ title: string, concept: string, onScreenText: string, styleNotes: string }} [input.current]
 * @returns {string}
 */
export function buildCodeAnimationBriefPrompt({
  universe = null,
  moodBoard = null,
  seedIdea = '',
  format,
  current = {},
}) {
  const { durationSeconds, aspectRatio } = format;
  const sections = [
    `You are a short-film director and writer. Write the brief for a ${durationSeconds}-second ${aspectRatio} animated film that will be drawn entirely in code — procedural shapes, strokes, particles, and typography, with no photographic or hand-drawn assets. Write something a creative coder can actually stage: silhouettes, light, motion, and a handful of clear beats rather than dialogue, facial acting, or crowds.`,
  ];
  if (isNonBlankStr(seedIdea)) {
    sections.push(`THE ARTIST'S SPARK — this is the film they want; honor it:\n${trimTo(seedIdea, B.seedIdeaMax)}`);
  }
  const universeText = universeSection(universe);
  if (universeText) sections.push(`UNIVERSE:\n${universeText}`);
  const castText = castSection(universe);
  if (castText) sections.push(castText);
  const boardText = moodBoardSection(moodBoard);
  if (boardText) sections.push(boardText);
  const currentText = currentSection(current);
  if (currentText) sections.push(currentText);
  if (!universe && !isNonBlankStr(seedIdea) && !currentText) {
    sections.push('No universe or starting idea was given — invent a striking, self-contained concept with a distinctive look.');
  }
  sections.push(`WRITE:
- title: a short evocative title (max 80 characters).
- concept: what happens, as a beat-by-beat account across the full ${durationSeconds} seconds (establish → develop → climax → resolve). Name the characters and places you are using, say what the camera does, and describe what the audience sees. 120–350 words, prose, no headings or markdown.
- onScreenText: the on-screen typography and narration beats, one per line, each led by its timestamp (e.g. \`0:02 "Every night, one light remains"\`). Use at most a handful, and leave it as an empty string if the film is better with no text at all.
- styleNotes: one or two sentences of refinement ON TOP OF the universe's established style — a palette shift, a grain, a camera behavior this particular film wants. Do NOT restate the universe's style; leave it an empty string if nothing needs refining.`);
  sections.push(`OUTPUT: Return ONLY a JSON object, in a single \`\`\`json fenced code block, with exactly these keys:
{"title": "...", "concept": "...", "onScreenText": "...", "styleNotes": "..."}
Every value is a plain string (use \\n for line breaks). No commentary before or after it, and do not create or edit any files.`);
  return sections.join('\n\n');
}

const briefShape = (value) => !!value && typeof value === 'object' && typeof value.concept === 'string';

const briefField = (value, max) => (typeof value === 'string' ? trimTo(value.trim(), max) : '');

/**
 * Parse a written brief out of a model response, clamped to the same limits the
 * brief form enforces. Throws a typed 502 when the response holds no usable
 * JSON object.
 */
export function extractBriefIdea(raw) {
  const { value, lastError, lastPreview } = extractJson(raw, { shapePredicate: briefShape });
  const concept = briefField(value?.concept, CODE_ANIMATION_LIMITS.conceptMax);
  if (!concept) {
    throw new ServerError('The model did not return a usable brief. Try a different model or rerun.', {
      status: 502,
      code: 'LLM_INVALID_JSON',
      context: { details: { reason: lastError?.message || 'no brief object found', preview: lastPreview || '' } },
    });
  }
  return {
    title: briefField(value.title, 200),
    concept,
    onScreenText: briefField(value.onScreenText, CODE_ANIMATION_LIMITS.textMax),
    styleNotes: briefField(value.styleNotes, CODE_ANIMATION_LIMITS.styleNotesMax),
  };
}
