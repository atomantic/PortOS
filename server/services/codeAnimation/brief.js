/**
 * Code Animation brief writer (pure).
 *
 * The sibling of `prompt.js`: where that one asks a model to CODE the film,
 * this one asks a model to WRITE the film — a title, a timed beat sheet, a
 * character design bible, the on-screen text beats, and any style refinement —
 * from the universe the user
 * picked, exactly as the series/story surfaces do. The universe's narrative
 * bible (logline, premise, style notes) and its canon cast/places/objects are
 * the source material, so a generated brief stars the world's own characters
 * in its own locations instead of inventing a parallel one.
 *
 * The writer plans the way a studio director briefs an animation team: a
 * one-line hook, a lead whose design is specified tightly enough to rig (and
 * locked so it survives style changes), wordless emotional acting, a payoff
 * every few seconds, a signature device, an anchor motif, and an ending that
 * lands. That plan is what lets the coding prompt aim at a studio short rather
 * than a screensaver.
 *
 * Text prompt, not an image prompt: free-text `styleNotes` belongs here (see
 * `lib/universeVisualStyle.js` for why the image side excludes it).
 *
 * Deterministic string assembly over already-resolved inputs — loading the
 * universe and board happens in `index.js`.
 */

import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';
import { extractJson } from '../../lib/jsonExtract.js';
import { renderCanonForPrompt } from '../../lib/universePromptRenderers.js';
import { ServerError } from '../../lib/errorHandler.js';
import { moodBoardSection, universeStyleLines } from '../../lib/styleSourcePrompt.js';
import { CODE_ANIMATION_LIMITS, PACING_RULE } from './prompt.js';

// What separates a studio short from a moving screensaver, distilled from how
// strong animation briefs are written. Static text — the per-film specifics
// come from the spark, universe, and board sections that follow.
const DIRECTING_PRINCIPLES = `HOW TO DIRECT IT:
- The film in one line: a premise that escalates and pays off with a reveal, twist, or loop. If you can't say it in one sentence, it's too complicated for this length.
- Wordless and readable: the story must land with zero dialogue. Characters act through their eyes, posture, and one signature expressive feature (an antenna, a tail, ears, a scarf), plus a small vocabulary of non-verbal sounds.
- Hook and density: ${PACING_RULE}. Escalate — each repetition of a device bigger or stranger than the last (the rule of three works).
- An emotional arc for the lead, beat by beat (e.g. delighted → curious → worried → determined), and one quiet, kind beat inside the chaos — often a small object or motif they protect — so we care.
- A signature device: one distinctive, recurring visual mechanism (a transition, a transformation, a rule of the world) that is this film's own, varied each time it recurs.
- Scale and camera: choose a point of view that makes the world cinematic (a tiny character with a camera at their eye level turns a curb into a cliff), and say how the camera moves in each beat.
- The ending lands: a reveal that reframes everything, a punchline held for a beat, or a seamless loop back to the first frame.`;

function universeSection(universe) {
  const lines = [`The film is set in the universe "${universe.name}". Everything you write must be canon to it.`];
  if (isNonBlankStr(universe.logline)) lines.push(`Logline: ${universe.logline}`);
  if (isNonBlankStr(universe.premise)) lines.push(`Premise: ${universe.premise}`);
  lines.push(...universeStyleLines(universe));
  if (isNonBlankStr(universe.styleNotes)) lines.push(`Tone, staging, and pacing notes: ${universe.styleNotes}`);
  return lines.join('\n');
}

// The cast the film is drawn from. `renderCanonForPrompt` is the project-wide
// canon→prompt block: it carries the per-kind formatting, the entry caps with
// their "+N more" footer, and — the reason a local projection would be wrong —
// the reveal gate, so a spoiler-flagged character's concealed history never
// reaches a generation prompt.
function castSection(universe) {
  const canon = renderCanonForPrompt(universe, { respectRevealGates: true });
  if (!canon) {
    return 'This universe has no canon characters, places, or objects recorded yet — invent ones that fit its logline and tone, and keep the cast small.';
  }
  return `CANON — cast the film from these and use their names:\n${canon}\n\nPrefer the canon above over inventing new entities. A character you use must behave, speak, and look as their entry describes.`;
}

function currentSection(current) {
  const rows = [
    ['Title', current.title],
    ['What happens', current.concept],
    ['Characters', current.cast],
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
 * @param {object|null} [input.universe] - the resolved universe: style tokens plus `{ logline, premise, characters, places, objects }`
 * @param {object|null} [input.moodBoard] - `collectBoardStyleContext` output
 * @param {string} [input.seedIdea] - the artist's starting spark, if any
 * @param {{ durationSeconds: number, aspectRatio: string }} input.format
 * @param {{ title: string, concept: string, cast?: string, onScreenText: string, styleNotes: string }} [input.current]
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
    `You are a short-film director and writer briefing an animation team. Write the brief for a ${durationSeconds}-second ${aspectRatio} animated short that will be drawn entirely in code — procedural shapes, strokes, particles, and typography, with no photographic or hand-drawn assets. Aim for a real studio short people want to share, and write something a creative coder can actually stage: a small cast with strong silhouettes, stylized faces, light, motion, and clear timed beats rather than dialogue, lip-sync, or crowds.`,
    DIRECTING_PRINCIPLES,
  ];
  if (isNonBlankStr(seedIdea)) {
    sections.push(`THE ARTIST'S SPARK — this is the film they want; honor it:\n${trimTo(seedIdea, CODE_ANIMATION_LIMITS.seedIdeaMax)}`);
  }
  if (universe) {
    sections.push(`UNIVERSE:\n${universeSection(universe)}`);
    sections.push(castSection(universe));
  }
  const boardText = moodBoardSection(moodBoard);
  if (boardText) sections.push(boardText);
  const currentText = currentSection(current);
  if (currentText) sections.push(currentText);
  if (!universe && !isNonBlankStr(seedIdea) && !currentText) {
    sections.push('No universe or starting idea was given — invent a striking, self-contained concept with a distinctive look.');
  }
  sections.push(`WRITE:
- title: a short evocative title (max 80 characters).
- concept: the director's plan. First line: the film in one sentence — premise, escalation, and the payoff or twist. Then the beat sheet, one line per beat, each led by its time range covering the full ${durationSeconds} seconds (e.g. \`0:00–0:03 …\`), grouped into a few acts. For each beat say where we are, what the characters do and feel (their expression and body language), what the camera does, and the visual payoff. Name the characters and places you use. 200–650 words, plain text, no markdown.
- cast: the design bible for the lead character(s), specific enough to build a 2D rig from without guessing — silhouette, proportions and scale, the parts and how they connect, a named palette with hex values, the face and a named expression set (at least five, each described by its shapes), the signature appendage that carries emotion, how they move, personality, and an identity lock (which features must never change, even when the world's style does). For canon characters, stay faithful to their entries and add the missing visual detail. 80–350 words, plain text, no markdown.
- onScreenText: the on-screen typography and narration beats, one per line, each led by its timestamp (e.g. \`0:02 "Every night, one light remains"\`). Use at most a handful — text that is part of the world (a sign, a typed prompt, a note) beats captions — and leave it as an empty string if the film is better with no text at all.
- styleNotes: one or two sentences of refinement ON TOP OF the universe's established style — a palette shift, a grain, a camera behavior this particular film wants. Do NOT restate the universe's style; leave it an empty string if nothing needs refining.`);
  sections.push(`OUTPUT: Return ONLY a JSON object, in a single \`\`\`json fenced code block, with exactly these keys:
{"title": "...", "concept": "...", "cast": "...", "onScreenText": "...", "styleNotes": "..."}
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
    title: briefField(value.title, CODE_ANIMATION_LIMITS.titleMax),
    concept,
    cast: briefField(value.cast, CODE_ANIMATION_LIMITS.castMax),
    onScreenText: briefField(value.onScreenText, CODE_ANIMATION_LIMITS.textMax),
    styleNotes: briefField(value.styleNotes, CODE_ANIMATION_LIMITS.styleNotesMax),
  };
}
