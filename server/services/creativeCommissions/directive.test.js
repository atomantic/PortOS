import { describe, it, expect } from 'vitest';
import {
  commissionToCron, commissionToRecurrence, renderFeedbackDigest, composeDirectiveGoal,
  MAX_DIRECTIVE_GOAL_LEN, MAX_SYSTEM_PREFIX_LEN,
} from './directive.js';
import { CREATIVE_DIRECTOR_GOAL_MAX } from '../../lib/creativeBriefLimits.js';
import {
  renderMusicTasteRecipePrompt,
  MUSIC_TASTE_RECIPE_MAX_CONTEXT, MUSIC_TASTE_RECIPE_MAX_SOURCE_VERSION,
} from './musicTasteRecipe.js';
import { COMMISSION_MUSIC_TASTE_ANCHOR_MAX } from '../../lib/creativeCommissionValidation.js';
import { buildVideoPromptGuidance } from './videoPromptGuidance.js';

// The goal budget is derived from the brief caps, but two of its terms are prose
// the derivation can only ALLOW FOR: the system prefix an adapter prepends, and
// the CD schema cap the composed goal has to pass on the HTTP path. Neither can
// be imported into directive.js (the first is prose, the second would invert the
// lib→service direction), so they are pinned here instead of left to a comment.
describe('directive goal budget invariants', () => {
  it('stays under the Creative Director schema cap for the goal', () => {
    expect(MAX_DIRECTIVE_GOAL_LEN).toBeLessThanOrEqual(CREATIVE_DIRECTOR_GOAL_MAX);
  });

  it('reserves enough prefix room for the longest system text an adapter prepends', () => {
    // The two candidates, each built at ITS OWN caps so growing one fails here
    // rather than silently eating the user's brief at compose time.
    const guidance = buildVideoPromptGuidance('minimax_h3_8bit');
    const tastePrompt = renderMusicTasteRecipePrompt({
      version: 1,
      sourceVersion: 'v'.repeat(MUSIC_TASTE_RECIPE_MAX_SOURCE_VERSION),
      sourceHash: 'h'.repeat(64),
      statedContext: 'x'.repeat(MUSIC_TASTE_RECIPE_MAX_CONTEXT),
      explorationPercent: 20,
      explorationDirection: 'balanced',
      anchors: Array.from({ length: COMMISSION_MUSIC_TASTE_ANCHOR_MAX }, (_, i) => ({
        kind: 'track', name: `n${i}${'a'.repeat(119)}`, artist: `r${i}${'b'.repeat(119)}`, count: 3, source: 'observed',
      })),
    });
    // + a lead sentence, the longest of which is the music-video one.
    const longestLead = 300;
    expect(Math.max(guidance.length, tastePrompt.length) + longestLead)
      .toBeLessThanOrEqual(MAX_SYSTEM_PREFIX_LEN);
  });
});


describe('commissionToCron', () => {
  it('composes a DAILY cron from HH:MM', () => {
    expect(commissionToCron({ kind: 'DAILY', atLocalTime: '02:00' })).toBe('0 2 * * *');
    expect(commissionToCron({ kind: 'DAILY', atLocalTime: '23:45' })).toBe('45 23 * * *');
  });

  it('restricts DAILY to weekdays when weekdaysOnly', () => {
    expect(commissionToCron({ kind: 'DAILY', atLocalTime: '09:30', weekdaysOnly: true })).toBe('30 9 * * 1-5');
  });

  it('composes a WEEKLY cron with a weekday', () => {
    expect(commissionToCron({ kind: 'WEEKLY', atLocalTime: '06:15', weekday: 0 })).toBe('15 6 * * 0');
    expect(commissionToCron({ kind: 'WEEKLY', atLocalTime: '18:00', weekday: 6 })).toBe('0 18 * * 6');
  });

  it('passes through a CUSTOM cron (trimmed)', () => {
    expect(commissionToCron({ kind: 'CUSTOM', cron: '  */15 * * * *  ' })).toBe('*/15 * * * *');
  });

  it('keeps rich calendar recurrence separate from its compatibility cron', () => {
    const recurrence = { frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2026-08-31' };
    const schedule = { kind: 'RECURRENCE', recurrence };
    expect(commissionToRecurrence(schedule)).toEqual(recurrence);
    expect(commissionToCron(schedule)).toBe('0 2 * * 1');
  });

  it('keeps weekday restrictions in the daily compatibility preview', () => {
    expect(commissionToCron({
      kind: 'RECURRENCE',
      recurrence: { frequency: 'daily', interval: 1, weekdays: [1, 3], time: '09:00' },
    })).toBe('0 9 * * 1,3');
  });

  it('returns null when required fields are missing', () => {
    expect(commissionToCron(null)).toBeNull();
    expect(commissionToCron({ kind: 'DAILY' })).toBeNull();
    expect(commissionToCron({ kind: 'DAILY', atLocalTime: '99:99' })).toBeNull();
    expect(commissionToCron({ kind: 'WEEKLY', atLocalTime: '02:00' })).toBeNull(); // no weekday
    expect(commissionToCron({ kind: 'WEEKLY', atLocalTime: '02:00', weekday: 7 })).toBeNull(); // out of range
    expect(commissionToCron({ kind: 'CUSTOM' })).toBeNull();
    expect(commissionToCron({ kind: 'NOPE', atLocalTime: '02:00' })).toBeNull();
  });
});

describe('renderFeedbackDigest', () => {
  it('returns empty string when there is no feedback (absent, not empty)', () => {
    expect(renderFeedbackDigest(undefined)).toBe('');
    expect(renderFeedbackDigest([])).toBe('');
    expect(renderFeedbackDigest(null, 5)).toBe('');
  });

  it('folds likes and dislikes with notes into a steering digest', () => {
    const digest = renderFeedbackDigest([
      { rating: 'up', note: 'dreamlike, Magritte-flat color' },
      { rating: 'down', note: 'horror, gore' },
    ]);
    expect(digest).toContain('Recent likes: dreamlike, Magritte-flat color.');
    expect(digest).toContain('Recent dislikes: horror, gore.');
    expect(digest).toContain('Steer toward the likes');
  });

  it('surfaces up/down tallies even when notes are empty (empty note is not absent feedback)', () => {
    const digest = renderFeedbackDigest([{ rating: 'up' }, { rating: 'down', note: '' }]);
    expect(digest).toContain('(liked, no note)');
    expect(digest).toContain('(disliked, no note)');
  });

  it('honors the window size (only the last N reactions)', () => {
    const feedback = [
      { rating: 'down', note: 'old dislike' },
      { rating: 'up', note: 'recent like' },
    ];
    const digest = renderFeedbackDigest(feedback, 1);
    expect(digest).toContain('recent like');
    expect(digest).not.toContain('old dislike');
  });

  it('returns empty string when windowSize is 0 (conditioning disabled)', () => {
    expect(renderFeedbackDigest([{ rating: 'up', note: 'x' }], 0)).toBe('');
  });

  it('gives a one-sided window the whole budget (does not reserve half for the absent group)', () => {
    // 3 × 300-char likes = ~900 chars — fits the full digest budget but would
    // overrun a half-budget (~730), truncating the newest like. With no dislikes,
    // the likes group must get the whole budget so all three survive.
    const feedback = [
      { rating: 'up', note: 'A'.repeat(300) },
      { rating: 'up', note: 'B'.repeat(300) },
      { rating: 'up', note: 'C'.repeat(300) },
    ];
    const digest = renderFeedbackDigest(feedback, 3);
    // newest-first: C should be present (it's the latest), and all three fit.
    expect(digest).toContain('C'.repeat(300));
    expect(digest).toContain('A'.repeat(300));
    expect(digest).not.toContain('Recent dislikes');
  });

  it('keeps recent dislikes even when many long likes precede them (per-group budget)', () => {
    const feedback = [
      ...Array.from({ length: 5 }, () => ({ rating: 'up', note: 'L'.repeat(300) })),
      { rating: 'down', note: 'newer dislike wins' },
    ];
    const digest = renderFeedbackDigest(feedback, 6);
    expect(digest).toContain('Recent likes:');
    expect(digest).toContain('Recent dislikes: newer dislike wins.');
    expect(digest).toContain('Steer toward the likes');
  });

  it('treats numeric ratings as up (>0) / down (<0)', () => {
    const digest = renderFeedbackDigest([{ rating: 1, note: 'plus' }, { rating: -1, note: 'minus' }]);
    expect(digest).toContain('Recent likes: plus.');
    expect(digest).toContain('Recent dislikes: minus.');
  });
});

describe('composeDirectiveGoal', () => {
  it('joins brief lines and appends the digest', () => {
    const goal = composeDirectiveGoal(['Create a video piece. surreal', 'Genre: x.'], 'Recent likes: more.');
    expect(goal).toBe('Create a video piece. surreal Genre: x. Recent likes: more.');
  });

  it('drops falsy lines and returns just the brief when there is no digest', () => {
    expect(composeDirectiveGoal(['A.', '', null, 'B.'], '')).toBe('A. B.');
  });

  it('reserves room for the digest and clamps the brief so the whole goal stays under the CD cap', () => {
    // A huge brief must not truncate away the digest (appended last, but reserved
    // for) — otherwise ratings stop steering the run.
    const goal = composeDirectiveGoal(['x'.repeat(MAX_DIRECTIVE_GOAL_LEN + 1500)], 'Recent dislikes: less horror.');
    expect(goal.length).toBeLessThanOrEqual(MAX_DIRECTIVE_GOAL_LEN);
    expect(goal).toContain('Recent dislikes: less horror.');
  });
});
