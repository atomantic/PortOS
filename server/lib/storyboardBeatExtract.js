/**
 * Beats from a plot summary — the instructions an LLM gets to break the
 * user's plot into storyboard beats and panels, and the parser for its answer.
 *
 * The plot is sent as the user wrote it; the instructions are one visible
 * block listed beside it (#11317), so Show full prompt names every word the
 * model read. The answer is a preview: nothing lands on the board until the
 * user adds it, and `parseExtractedBeats` keeps only fields a board holds.
 *
 * Browser-safe: no node-only imports.
 */

import { normalizeShotType } from './shotGrammar.js';
import { trimTo as text } from './textUtils.js';
import { STORYBOARD_LIMITS, STORYBOARD_MUSICAL_ROLES, STORYBOARD_PANEL_FRAMINGS } from './storyboardVocabulary.js';

export const BEAT_EXTRACT_LIMITS = Object.freeze({ plot: 20000, beats: 40, panelsPerBeat: 12 });

/** The instructions block, sent ahead of the plot and shown as its own chip. */
export function beatExtractInstructions() {
  return [
    'You break a plot summary into story beats for a storyboard, each with the panels (planned shots) that tell it.',
    'Keep to the story you are given: its people, places and order. Do not add characters or events it does not imply.',
    `Write at most ${BEAT_EXTRACT_LIMITS.beats} beats, each with 1 to ${BEAT_EXTRACT_LIMITS.panelsPerBeat} panels. Each panel shows one action.`,
    'Answer with JSON only, in this shape:',
    '{"beats":[{"title":"","what":"","why":"","emotion":"","musicalRole":"","panels":[{"action":"","dialogue":"","framing":"","camera":"","seconds":0}]}]}',
    '- title: a short name for the beat. what: what happens. why: why it matters to the story. emotion: the feeling, a word or two.',
    `- musicalRole: one of ${STORYBOARD_MUSICAL_ROLES.join(', ')}, or "" when none fits.`,
    '- action: what we see in the shot. dialogue: a spoken or sung line, or "".',
    `- framing: one of ${STORYBOARD_PANEL_FRAMINGS.join(', ')}. camera: the camera move, or "".`,
    '- seconds: an estimated screen time in seconds (a number), or 0 when unsure.',
  ].join('\n');
}

/** The one text the model reads: the instructions, then the user's plot. */
export const beatExtractPrompt = (instructions, plot) => `${instructions}\n\n---\n\nPlot summary:\n${plot}`;

function parsePanel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const action = text(raw.action, STORYBOARD_LIMITS.panelText);
  const dialogue = text(raw.dialogue, STORYBOARD_LIMITS.panelText);
  if (!action && !dialogue) return null;
  const seconds = typeof raw.seconds === 'number' && Number.isFinite(raw.seconds) && raw.seconds > 0
    ? Math.round(Math.min(raw.seconds, STORYBOARD_LIMITS.panelSecondsMax) * 100) / 100
    : null;
  return {
    action,
    dialogue,
    framing: normalizeShotType(raw.framing),
    camera: text(raw.camera, STORYBOARD_LIMITS.camera),
    seconds,
  };
}

function parseBeat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const panels = (Array.isArray(raw.panels) ? raw.panels : []).map(parsePanel).filter(Boolean).slice(0, BEAT_EXTRACT_LIMITS.panelsPerBeat);
  const title = text(raw.title, STORYBOARD_LIMITS.beatTitle);
  const what = text(raw.what, STORYBOARD_LIMITS.beatText);
  if (!title && !what && !panels.length) return null;
  return {
    title,
    what,
    why: text(raw.why, STORYBOARD_LIMITS.beatText),
    emotion: text(raw.emotion, STORYBOARD_LIMITS.emotion),
    musicalRole: STORYBOARD_MUSICAL_ROLES.includes(raw.musicalRole) ? raw.musicalRole : null,
    panels,
  };
}

/**
 * The beats in a model's answer: the JSON object (fenced or wrapped in prose)
 * reduced to the fields a board holds. Throws when no beat can be read.
 */
export function parseExtractedBeats(answer) {
  const source = String(answer || '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  let parsed = null;
  if (start !== -1 && end > start) {
    try {
      parsed = JSON.parse(source.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  const beats = (Array.isArray(parsed?.beats) ? parsed.beats : []).map(parseBeat).filter(Boolean).slice(0, BEAT_EXTRACT_LIMITS.beats);
  if (!beats.length) throw new Error('The model did not answer with any beats in the asked-for JSON.');
  return beats;
}
