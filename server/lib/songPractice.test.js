import { describe, it, expect } from 'vitest';
import {
  SONG_PROMOTE_MIN_QUALITY,
  SONG_REGRESS_MAX_QUALITY,
  SONG_STAGE_ORDER,
  applySongPractice,
  isSongDue,
  nextSongStage,
  songPracticeOrDefault,
} from './songPractice.js';
import { songStageEnum } from './brainValidation.js';
import { DEFAULT_EASE } from './spacedRepetition.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const LATER = new Date('2026-03-14T12:00:00.000Z');

const song = (overrides = {}) => ({
  id: 'song-1',
  title: 'Example Song',
  stage: 'learning',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  ...overrides,
});

describe('SONG_STAGE_ORDER', () => {
  it('mirrors songStageEnum, in ladder order', () => {
    expect(SONG_STAGE_ORDER).toEqual(songStageEnum.options);
  });
});

describe('songPracticeOrDefault', () => {
  it('derives a schedule for a song that predates the feature', () => {
    const derived = songPracticeOrDefault(song());
    expect(derived).toEqual({
      ease: DEFAULT_EASE,
      intervalDays: 0,
      // Anchored to the song's own updatedAt — stable across reads, in the past.
      nextReview: '2026-02-01T00:00:00.000Z',
      lastReviewed: null,
    });
    expect(songPracticeOrDefault(song())).toEqual(derived);
  });

  it('returns a stored practice schedule untouched', () => {
    const practice = { ease: 2.6, intervalDays: 6, nextReview: '2026-04-01T00:00:00.000Z', sessions: 3 };
    expect(songPracticeOrDefault(song({ practice }))).toBe(practice);
  });
});

describe('isSongDue', () => {
  it('treats a never-practiced song as due', () => {
    expect(isSongDue(song(), NOW)).toBe(true);
  });

  it('respects a scheduled future review', () => {
    const scheduled = song({ practice: { ease: 2.5, intervalDays: 6, nextReview: '2026-03-20T00:00:00.000Z' } });
    expect(isSongDue(scheduled, NOW)).toBe(false);
    expect(isSongDue(scheduled, new Date('2026-03-21T00:00:00.000Z'))).toBe(true);
  });
});

describe('nextSongStage', () => {
  it('promotes one rung at or above the promote grade', () => {
    expect(nextSongStage('new', SONG_PROMOTE_MIN_QUALITY)).toBe('learning');
    expect(nextSongStage('learning', 5)).toBe('learned');
    expect(nextSongStage('learned', 4)).toBe('memorized');
  });

  it('holds at the top of the ladder', () => {
    expect(nextSongStage('memorized', 5)).toBe('memorized');
  });

  it('holds on a middling grade', () => {
    expect(nextSongStage('learning', 3)).toBe('learning');
    expect(nextSongStage('memorized', 3)).toBe('memorized');
  });

  it('regresses one rung at or below the regress grade', () => {
    expect(nextSongStage('memorized', SONG_REGRESS_MAX_QUALITY)).toBe('learned');
    expect(nextSongStage('learned', 0)).toBe('learning');
  });

  it('floors a practiced song at learning — never back to new', () => {
    expect(nextSongStage('learning', 0)).toBe('learning');
    // A bad first run on an untouched song still means you have STARTED it.
    expect(nextSongStage('new', 0)).toBe('learning');
  });

  it('leaves a stage this install does not recognize alone', () => {
    expect(nextSongStage('gigging', 5)).toBe('gigging');
    expect(nextSongStage('gigging', 0)).toBe('gigging');
    expect(nextSongStage(undefined, 5)).toBe(undefined);
  });

  it('holds a promotion when promotion is gated', () => {
    expect(nextSongStage('learning', 5, { allowPromotion: false })).toBe('learning');
    // A regression is never gated.
    expect(nextSongStage('learned', 0, { allowPromotion: false })).toBe('learning');
  });
});

describe('applySongPractice', () => {
  it('returns only the fields to persist', () => {
    expect(Object.keys(applySongPractice(song(), 5, NOW)).sort()).toEqual(['practice', 'stage']);
  });

  it('advances the schedule and the stage on a good first run', () => {
    const { stage, practice } = applySongPractice(song(), 5, NOW);
    expect(stage).toBe('learned');
    expect(practice.intervalDays).toBe(1);
    expect(practice.lastReviewed).toBe(NOW.toISOString());
    expect(practice.sessions).toBe(1);
    expect(practice.lastQuality).toBe(5);
    expect(isSongDue({ practice }, NOW)).toBe(false);
  });

  it('resurfaces the song immediately and regresses the stage on a bad run', () => {
    const practiced = song({
      stage: 'memorized',
      practice: { ease: 2.5, intervalDays: 30, nextReview: NOW.toISOString(), lastReviewed: '2026-02-08T12:00:00.000Z', sessions: 4 },
    });
    const { stage, practice } = applySongPractice(practiced, 0, NOW);
    expect(stage).toBe('learned');
    expect(practice.intervalDays).toBe(0);
    expect(practice.sessions).toBe(5);
    expect(isSongDue({ practice }, NOW)).toBe(true);
  });

  it('counts two sessions in one day as one day of progress', () => {
    const first = applySongPractice(song({ stage: 'new' }), 5, NOW);
    const second = applySongPractice(song({ stage: first.stage, practice: first.practice }), 5, NOW);
    // Stage held and the interval did not compound…
    expect(second.stage).toBe(first.stage);
    expect(second.practice.intervalDays).toBe(first.practice.intervalDays);
    expect(second.practice.nextReview).toBe(first.practice.nextReview);
    // …but the session still counted.
    expect(second.practice.sessions).toBe(2);
  });

  it('advances again on a later day', () => {
    const first = applySongPractice(song({ stage: 'new' }), 5, NOW);
    const second = applySongPractice(song({ stage: first.stage, practice: first.practice }), 5, LATER);
    expect(second.stage).toBe('learned');
    expect(second.practice.intervalDays).toBeGreaterThan(first.practice.intervalDays);
  });

  it('applies a same-day miss even after a same-day success', () => {
    const good = applySongPractice(song({ stage: 'learning' }), 5, NOW);
    const bad = applySongPractice(song({ stage: good.stage, practice: good.practice }), 0, NOW);
    expect(bad.practice.intervalDays).toBe(0);
    expect(bad.stage).toBe('learning');
  });

  it('starts session counting from 1 for a song with no practice history', () => {
    expect(applySongPractice(song(), 3, NOW).practice.sessions).toBe(1);
    // A corrupt/absent counter must not produce NaN.
    expect(applySongPractice(song({ practice: { nextReview: NOW.toISOString(), sessions: 'many' } }), 3, NOW).practice.sessions).toBe(1);
  });

  it('is pure — the song record is never mutated', () => {
    const record = song({ practice: { ease: 2.5, intervalDays: 6, nextReview: NOW.toISOString(), lastReviewed: null, sessions: 1 } });
    const snapshot = JSON.parse(JSON.stringify(record));
    applySongPractice(record, 5, LATER);
    expect(JSON.parse(JSON.stringify(record))).toEqual(snapshot);
  });
});
