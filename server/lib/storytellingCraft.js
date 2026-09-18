/**
 * Storytelling craft rubric — pure: no I/O, no clock, no provider call.
 *
 * Declares the seven moves and the CART structure the autobiography feature
 * scores a written story against, plus the prompt builder and the normalizer
 * that turns an LLM's JSON answer into a shape the UI can render without
 * re-checking every field.
 *
 * Source of the rubric: Shannon Jenkins, "How to Tell Stories Better Than 99%
 * of People" (https://youtu.be/lghSjBl9yGM) — the two Ted Lasso scenes it
 * breaks down end on a seven-move summary plus the CART framework (Context,
 * Action, Result, Takeaway).
 *
 * It lives in lib/ rather than beside the service because it is the contract
 * two sides share: the service builds a provider prompt from it, and the
 * client renders a score row per move. A move added here shows up in both
 * without either side re-listing the vocabulary.
 */

import { trimToClause } from './textUtils.js';

/** Highest per-move score the rubric uses. Scores are integers in 0..5. */
export const STORY_CRAFT_MAX_SCORE = 5;

/**
 * The seven moves, in the order the video lands them. `id` is the stable key
 * the LLM answers with and the client keys rows on — never renumber it.
 */
export const STORY_CRAFT_MOVES = Object.freeze([
  Object.freeze({
    id: 'curiosity',
    label: 'Create curiosity',
    description: 'An unanswered question, information deliberately held back, or a destination the reader wants to be taken to.',
  }),
  Object.freeze({
    id: 'tension',
    label: 'Create tension',
    description: 'A reason to care what happens next — something uncertain, something at stake, something the reader wants resolved.',
  }),
  Object.freeze({
    id: 'specificity',
    label: 'Zoom in to a specific moment',
    description: 'One concrete scene — the particular conversation, room, or instant something changed — instead of a helicopter-view summary.',
  }),
  Object.freeze({
    id: 'pace',
    label: 'Change the pace',
    description: 'Slow down around the moments the reader should experience; move fast through the connective tissue they only need in order to follow.',
  }),
  Object.freeze({
    id: 'unexpected',
    label: 'Introduce something unexpected',
    description: 'A twist, a surprising detail, or an opening nobody saw coming — including a reveal that makes the reader reinterpret what came before.',
  }),
  Object.freeze({
    id: 'personal',
    label: 'Close the warmth gap',
    description: 'A well-chosen personal detail that lets the human being show through. Personal, not private — one revealing detail beats confession.',
  }),
  Object.freeze({
    id: 'takeaway',
    label: 'Land with a takeaway',
    description: 'What it meant and why you told it — the ending that makes the whole story click into place.',
  }),
]);

export const STORY_CRAFT_MOVE_IDS = Object.freeze(STORY_CRAFT_MOVES.map((m) => m.id));

/**
 * CART — the structural spine underneath the seven moves. Scored as
 * present/absent with a one-line note rather than 0..5: a story either takes
 * the reader through the stage or it doesn't.
 */
export const CART_STAGES = Object.freeze([
  Object.freeze({ id: 'context', label: 'Context', description: 'Who, where, when — just enough for the rest to land.' }),
  Object.freeze({ id: 'action', label: 'Action', description: 'What actually happened, in scene.' }),
  Object.freeze({ id: 'result', label: 'Result', description: 'How it turned out.' }),
  Object.freeze({ id: 'takeaway', label: 'Takeaway', description: 'What it means for whoever is listening. The stage people most often drop.' }),
]);

export const CART_STAGE_IDS = Object.freeze(CART_STAGES.map((s) => s.id));

const clampScore = (value) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(STORY_CRAFT_MAX_SCORE, Math.max(0, n));
};

// Every prose field here comes straight off an LLM and is persisted into
// stories.json, so bound it where it enters the system rather than capping
// downstream. `trimToClause` rather than `trimTo`: these are sentences the user
// reads as advice, and a cut that lands mid-thought reads as a bug in the
// coaching. Non-strings normalize to '' inside the helper, so an absent field
// reads as empty, never as `undefined`.
const MAX_MOVE_NOTE = 400;
const MAX_REVISION = 1000;
const cleanText = (value, max = MAX_MOVE_NOTE) => trimToClause(value, max);

/**
 * Build the evaluation prompt for one story.
 *
 * `question` is the question the story answers — the autobiography feature
 * treats every story as an answer to a question, direct ("Why do I like black
 * licorice?") or implied ("Describe the house you grew up in"), so the rubric
 * can judge whether the piece actually answers it.
 */
export function buildStoryCraftEvaluationPrompt({ question, story }) {
  const moveLines = STORY_CRAFT_MOVES
    .map((m, i) => `${i + 1}. ${m.id} — ${m.label}: ${m.description}`)
    .join('\n');
  const cartLines = CART_STAGES
    .map((s) => `- ${s.id} (${s.label}): ${s.description}`)
    .join('\n');

  return `You are a storytelling coach. Evaluate the personal story below against a fixed rubric of seven moves and the CART structure. Be a generous reader but an honest scorer — say what is actually on the page, not what a charitable reading could infer.

THE QUESTION THE STORY IS ANSWERING:
${question || '(none given — infer the implied question the story answers)'}

THE STORY:
"""
${story}
"""

THE SEVEN MOVES (score each 0-${STORY_CRAFT_MAX_SCORE}, where 0 = absent, 3 = present but ordinary, ${STORY_CRAFT_MAX_SCORE} = executed the way a great storyteller would):
${moveLines}

CART STRUCTURE (present: true/false for each):
${cartLines}

For every move give:
- score: integer 0-${STORY_CRAFT_MAX_SCORE}
- evidence: a short quote or paraphrase from the story showing what earned that score (or what is missing)
- suggestion: one concrete, specific revision the writer could make. Name the sentence or beat to change. No generic advice.

Also give:
- answersQuestion: true/false — does the story actually answer the question above?
- revision: two or three sentences describing the single highest-leverage rewrite.

Return ONLY JSON, no prose or markdown fences, in exactly this shape:
{
  "moves": { ${STORY_CRAFT_MOVE_IDS.map((id) => `"${id}": { "score": 0, "evidence": "", "suggestion": "" }`).join(', ')} },
  "cart": { ${CART_STAGE_IDS.map((id) => `"${id}": { "present": true, "note": "" }`).join(', ')} },
  "answersQuestion": true,
  "revision": ""
}`;
}

/**
 * Normalize a parsed LLM answer into the render-ready evaluation.
 *
 * Every move and CART stage is emitted in canonical order whether or not the
 * model returned it — a missing move scores 0 with an empty note rather than
 * vanishing from the row list, so a truncated answer reads as "not assessed
 * and therefore not credited" instead of silently shortening the rubric.
 *
 * `overallScore` is the mean move score to one decimal. Returns null when the
 * payload is not an object at all, which is the caller's signal to report a
 * parse failure rather than persist an all-zero evaluation.
 */
export function normalizeStoryCraftEvaluation(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const rawMoves = (parsed.moves && typeof parsed.moves === 'object') ? parsed.moves : {};
  const moves = STORY_CRAFT_MOVES.map((move) => {
    const entry = rawMoves[move.id];
    const source = (entry && typeof entry === 'object') ? entry : {};
    return {
      id: move.id,
      label: move.label,
      score: clampScore(source.score),
      evidence: cleanText(source.evidence),
      suggestion: cleanText(source.suggestion),
    };
  });

  const rawCart = (parsed.cart && typeof parsed.cart === 'object') ? parsed.cart : {};
  const cart = CART_STAGES.map((stage) => {
    const entry = rawCart[stage.id];
    const source = (entry && typeof entry === 'object') ? entry : {};
    return {
      id: stage.id,
      label: stage.label,
      present: source.present === true,
      note: cleanText(source.note),
    };
  });

  const total = moves.reduce((sum, m) => sum + m.score, 0);
  const overallScore = Math.round((total / moves.length) * 10) / 10;

  // Strongest/weakest are the row the writer should keep doing and the row to
  // work on next. Ties resolve to rubric order, which is the order the video
  // teaches them in — a deterministic answer beats an arbitrary one.
  const strongest = moves.reduce((best, m) => (m.score > best.score ? m : best), moves[0]);
  const weakest = moves.reduce((worst, m) => (m.score < worst.score ? m : worst), moves[0]);

  return {
    moves,
    cart,
    overallScore,
    maxScore: STORY_CRAFT_MAX_SCORE,
    strongestMoveId: strongest.id,
    weakestMoveId: weakest.id,
    answersQuestion: parsed.answersQuestion !== false,
    revision: cleanText(parsed.revision, MAX_REVISION),
  };
}
