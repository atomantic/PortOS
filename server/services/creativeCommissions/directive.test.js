import { describe, it, expect } from 'vitest';
import { commissionToCron, renderFeedbackDigest, buildCommissionDirective } from './directive.js';

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

  it('treats numeric ratings as up (>0) / down (<0)', () => {
    const digest = renderFeedbackDigest([{ rating: 1, note: 'plus' }, { rating: -1, note: 'minus' }]);
    expect(digest).toContain('Recent likes: plus.');
    expect(digest).toContain('Recent dislikes: minus.');
  });
});

describe('buildCommissionDirective', () => {
  it('composes goal + deliverables + constraints from the brief', () => {
    const directive = buildCommissionDirective({
      name: 'Nightly Surreal',
      targetAbility: 'video',
      brief: {
        intent: 'something surreal, dreamlike, unsettlingly beautiful',
        genre: 'surrealism',
        styleSpec: 'flat color, Magritte',
        constraints: { universeId: 'u-123' },
      },
      feedbackWindow: 5,
    });
    expect(directive.goal).toContain('Create a video piece.');
    expect(directive.goal).toContain('something surreal');
    expect(directive.goal).toContain('Genre: surrealism.');
    expect(directive.goal).toContain('Style: flat color, Magritte.');
    expect(directive.deliverables).toEqual(['One video artifact matching the brief']);
    expect(directive.constraints).toEqual({ universeId: 'u-123' });
  });

  it('folds recent feedback into the goal', () => {
    const directive = buildCommissionDirective({
      targetAbility: 'video',
      brief: { intent: 'surreal' },
      feedback: [{ rating: 'down', note: 'less horror' }, { rating: 'up', note: 'more Magritte' }],
      feedbackWindow: 5,
    });
    expect(directive.goal).toContain('Recent likes: more Magritte.');
    expect(directive.goal).toContain('Recent dislikes: less horror.');
  });

  it('omits absent constraints', () => {
    const directive = buildCommissionDirective({ targetAbility: 'video', brief: { intent: 'x' } });
    expect(directive.constraints).toEqual({});
  });
});
