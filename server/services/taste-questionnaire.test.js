import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({
  prefix: 'portos-taste-',
  // taste-questionnaire binds PATHS.digitalTwin at module load; redirect it
  // into the temp tree so tests never touch the real install profile.
  extraOverrides: (dataRoot) => ({
    digitalTwin: join(dataRoot, 'digital-twin'),
  }),
});

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// Avoid digitalTwinEvents side effects during answer submit
vi.mock('./digital-twin.js', () => ({
  digitalTwinEvents: { emit: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  cleanup();
});

describe('getNextQuestion progress', () => {
  it('reports core index, not total responses, after follow-ups', async () => {
    const taste = await import('./taste-questionnaire.js');

    // Core Q1
    let next = await taste.getNextQuestion('food');
    expect(next.questionId).toBe('food-core-1');
    expect(next.progress).toEqual({
      current: 1,
      coreTotal: 3,
      totalAnswered: 0,
    });

    // Answer with a spice trigger so a follow-up is queued
    await taste.submitAnswer('food', 'food-core-1', 'I love intense spice and heat');

    next = await taste.getNextQuestion('food');
    expect(next.isFollowUp).toBe(true);
    expect(next.questionId).toBe('food-fu-spice');
    // Follow-up still anchors progress to the parent core question
    expect(next.progress.current).toBe(1);
    expect(next.progress.coreTotal).toBe(3);
    expect(next.progress.totalAnswered).toBe(1);

    await taste.submitAnswer('food', 'food-fu-spice', 'Thai and Sichuan especially');

    // Core Q2 — must be "2 of 3", not "3 of 3" (responses.length + 1)
    next = await taste.getNextQuestion('food');
    expect(next.questionId).toBe('food-core-2');
    expect(next.isFollowUp).toBe(false);
    expect(next.progress).toEqual({
      current: 2,
      coreTotal: 3,
      totalAnswered: 2,
    });

    await taste.submitAnswer(
      'food',
      'food-core-2',
      'I cook improvisationally, rarely following recipes'
    );

    next = await taste.getNextQuestion('food');
    // Improvisational answer triggers food-fu-improv
    expect(next.isFollowUp).toBe(true);
    expect(next.progress.current).toBe(2);
    expect(next.progress.coreTotal).toBe(3);

    await taste.submitAnswer('food', next.questionId, 'Yes, freestyle almost always');

    // Core Q3 after two cores + two follow-ups → still "3 of 3", never "5 of 3"
    next = await taste.getNextQuestion('food');
    expect(next.questionId).toBe('food-core-3');
    expect(next.isFollowUp).toBe(false);
    expect(next.progress).toEqual({
      current: 3,
      coreTotal: 3,
      totalAnswered: 4,
    });
    expect(next.progress.current).toBeLessThanOrEqual(next.progress.coreTotal);
  });

  it('starts at Question 1 of N with no prior responses', async () => {
    const taste = await import('./taste-questionnaire.js');
    await taste.resetSection('movies');

    const next = await taste.getNextQuestion('movies');
    expect(next.questionId).toBe('movies-core-1');
    expect(next.progress.current).toBe(1);
    expect(next.progress.coreTotal).toBe(3);
    expect(next.progress.totalAnswered).toBe(0);
  });
});
