/**
 * Tests for the storytelling-craft rubric. The prompt builder and the
 * normalizer sit either side of an LLM round trip, so the assertions here are
 * about what the rubric GUARANTEES regardless of what the model returns: every
 * move and CART stage present in canonical order, scores bounded, and a
 * non-object payload rejected rather than persisted as an all-zero score.
 */

import { describe, it, expect } from 'vitest';
import {
  STORY_CRAFT_MOVES,
  STORY_CRAFT_MOVE_IDS,
  STORY_CRAFT_MAX_SCORE,
  CART_STAGE_IDS,
  buildStoryCraftEvaluationPrompt,
  normalizeStoryCraftEvaluation
} from './storytellingCraft.js';

const fullAnswer = (scores) => ({
  moves: Object.fromEntries(
    STORY_CRAFT_MOVE_IDS.map((id, i) => [id, {
      score: scores[i],
      evidence: `  evidence ${id}  `,
      suggestion: `suggestion ${id}`
    }])
  ),
  cart: Object.fromEntries(CART_STAGE_IDS.map(id => [id, { present: true, note: `note ${id}` }])),
  answersQuestion: true,
  revision: '  tighten the opening  '
});

describe('buildStoryCraftEvaluationPrompt', () => {
  it('names every move id so the model answers in the keys the normalizer reads', () => {
    const prompt = buildStoryCraftEvaluationPrompt({ question: 'Why do I like black licorice?', story: 'A story.' });

    for (const id of STORY_CRAFT_MOVE_IDS) {
      expect(prompt).toContain(id);
    }
    for (const id of CART_STAGE_IDS) {
      expect(prompt).toContain(id);
    }
  });

  it('includes the question and the story text', () => {
    const prompt = buildStoryCraftEvaluationPrompt({
      question: 'Why do I like black licorice?',
      story: 'It started at my grandmother’s kitchen table.'
    });

    expect(prompt).toContain('Why do I like black licorice?');
    expect(prompt).toContain('It started at my grandmother’s kitchen table.');
  });

  it('tells the model to infer the implied question when none was given', () => {
    const prompt = buildStoryCraftEvaluationPrompt({ question: '', story: 'A story.' });

    expect(prompt).toMatch(/infer the implied question/i);
  });
});

describe('normalizeStoryCraftEvaluation', () => {
  it('rejects a non-object payload rather than scoring it zero', () => {
    expect(normalizeStoryCraftEvaluation(null)).toBeNull();
    expect(normalizeStoryCraftEvaluation('not json')).toBeNull();
    expect(normalizeStoryCraftEvaluation([1, 2, 3])).toBeNull();
  });

  it('returns every move and CART stage in canonical order', () => {
    const result = normalizeStoryCraftEvaluation(fullAnswer([5, 4, 3, 2, 1, 0, 5]));

    expect(result.moves.map(m => m.id)).toEqual([...STORY_CRAFT_MOVE_IDS]);
    expect(result.cart.map(s => s.id)).toEqual([...CART_STAGE_IDS]);
    expect(result.moves[0].label).toBe(STORY_CRAFT_MOVES[0].label);
  });

  it('credits a move the model omitted as zero instead of dropping the row', () => {
    const partial = fullAnswer([5, 5, 5, 5, 5, 5, 5]);
    delete partial.moves.takeaway;

    const result = normalizeStoryCraftEvaluation(partial);

    expect(result.moves).toHaveLength(STORY_CRAFT_MOVE_IDS.length);
    const takeaway = result.moves.find(m => m.id === 'takeaway');
    expect(takeaway.score).toBe(0);
    expect(takeaway.evidence).toBe('');
  });

  it('bounds a score the model returned out of range', () => {
    const wild = fullAnswer([99, -4, 3, 3, 3, 3, 3]);

    const result = normalizeStoryCraftEvaluation(wild);

    expect(result.moves[0].score).toBe(STORY_CRAFT_MAX_SCORE);
    expect(result.moves[1].score).toBe(0);
  });

  it('treats a non-numeric score as zero rather than NaN', () => {
    const wild = fullAnswer(['great', 3, 3, 3, 3, 3, 3]);

    expect(normalizeStoryCraftEvaluation(wild).moves[0].score).toBe(0);
  });

  it('averages the move scores to one decimal', () => {
    // 5+4+3+2+1+0+5 = 20 over 7 moves = 2.857… → 2.9
    const result = normalizeStoryCraftEvaluation(fullAnswer([5, 4, 3, 2, 1, 0, 5]));

    expect(result.overallScore).toBe(2.9);
    expect(result.maxScore).toBe(STORY_CRAFT_MAX_SCORE);
  });

  it('names the strongest and weakest move, breaking ties in rubric order', () => {
    const result = normalizeStoryCraftEvaluation(fullAnswer([5, 5, 1, 1, 3, 3, 3]));

    expect(result.strongestMoveId).toBe(STORY_CRAFT_MOVE_IDS[0]);
    expect(result.weakestMoveId).toBe(STORY_CRAFT_MOVE_IDS[2]);
  });

  it('trims prose and defaults answersQuestion to true when the model omits it', () => {
    const answer = fullAnswer([3, 3, 3, 3, 3, 3, 3]);
    delete answer.answersQuestion;

    const result = normalizeStoryCraftEvaluation(answer);

    expect(result.revision).toBe('tighten the opening');
    expect(result.moves[0].evidence).toBe(`evidence ${STORY_CRAFT_MOVE_IDS[0]}`);
    expect(result.answersQuestion).toBe(true);
  });

  it('carries an explicit answersQuestion:false through', () => {
    const answer = { ...fullAnswer([3, 3, 3, 3, 3, 3, 3]), answersQuestion: false };

    expect(normalizeStoryCraftEvaluation(answer).answersQuestion).toBe(false);
  });

  it('treats a CART stage as absent unless the model said true', () => {
    const answer = fullAnswer([3, 3, 3, 3, 3, 3, 3]);
    answer.cart.takeaway = { present: 'yes', note: 'ambiguous' };
    delete answer.cart.result;

    const result = normalizeStoryCraftEvaluation(answer);

    expect(result.cart.find(s => s.id === 'takeaway').present).toBe(false);
    expect(result.cart.find(s => s.id === 'result').present).toBe(false);
    expect(result.cart.find(s => s.id === 'context').present).toBe(true);
  });
});
