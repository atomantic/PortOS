import { describe, it, expect } from 'vitest';
import {
  COMMISSION_FEEDBACK_KIND,
  CFEEDBACK_ID_RE,
  deterministicFeedbackId,
  sanitizeCommissionFeedbackForSync,
  mergeCommissionFeedbackRecord,
  toInlineFeedback,
} from './feedbackLogic.js';

describe('feedbackLogic — kind + id', () => {
  it('names the record kind', () => {
    expect(COMMISSION_FEEDBACK_KIND).toBe('commissionFeedback');
  });

  it('mints a deterministic id per run and null for a missing run', () => {
    expect(deterministicFeedbackId('run-abc')).toBe('cfeedback-run-abc');
    expect(CFEEDBACK_ID_RE.test(deterministicFeedbackId('run-abc'))).toBe(true);
    expect(deterministicFeedbackId(null)).toBeNull();
    expect(deterministicFeedbackId('')).toBeNull();
  });
});

describe('sanitizeCommissionFeedbackForSync', () => {
  it('normalizes an up/down reaction with the soft-delete trio', () => {
    const rec = sanitizeCommissionFeedbackForSync({
      id: 'cfeedback-run-1', commissionId: 'commission-x', runId: 'run-1',
      rating: 'up', note: 'more Magritte', tags: ['surreal', 42], at: '2026-01-01T00:00:00.000Z',
    });
    expect(rec).toMatchObject({
      id: 'cfeedback-run-1', commissionId: 'commission-x', runId: 'run-1',
      rating: 'up', note: 'more Magritte', tags: ['surreal'], deleted: false, deletedAt: null,
    });
    expect(rec.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('preserves a non-zero numeric rating verbatim', () => {
    expect(sanitizeCommissionFeedbackForSync({ id: 'cfeedback-a', rating: 3 }).rating).toBe(3);
    expect(sanitizeCommissionFeedbackForSync({ id: 'cfeedback-a', rating: -2 }).rating).toBe(-2);
  });

  it('drops a record with a bad id, no id, or no usable rating', () => {
    expect(sanitizeCommissionFeedbackForSync({ id: 'nope', rating: 'up' })).toBeNull();
    expect(sanitizeCommissionFeedbackForSync({ rating: 'up' })).toBeNull();
    expect(sanitizeCommissionFeedbackForSync({ id: 'cfeedback-a', rating: 0 })).toBeNull();
    expect(sanitizeCommissionFeedbackForSync({ id: 'cfeedback-a', rating: 'meh' })).toBeNull();
    expect(sanitizeCommissionFeedbackForSync(null)).toBeNull();
  });

  it('normalizes a tombstone', () => {
    const rec = sanitizeCommissionFeedbackForSync({ id: 'cfeedback-a', rating: 'up', deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' });
    expect(rec.deleted).toBe(true);
    expect(rec.deletedAt).toBe('2026-02-02T00:00:00.000Z');
  });
});

describe('mergeCommissionFeedbackRecord (LWW)', () => {
  const base = { id: 'cfeedback-run-1', commissionId: 'c1', runId: 'run-1', rating: 'up', at: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

  it('inserts when there is no local copy', () => {
    const { next, inserted, remoteWins } = mergeCommissionFeedbackRecord(null, base);
    expect(inserted).toBe(true);
    expect(remoteWins).toBe(true);
    expect(next.id).toBe('cfeedback-run-1');
  });

  it('newer remote updatedAt wins', () => {
    const local = { ...base };
    const remote = { ...base, rating: 'down', updatedAt: '2026-03-03T00:00:00.000Z' };
    const { next, remoteWins, changed } = mergeCommissionFeedbackRecord(local, remote);
    expect(remoteWins).toBe(true);
    expect(changed).toBe(true);
    expect(next.rating).toBe('down');
  });

  it('older remote loses to a newer local (LWW, no clobber)', () => {
    const local = { ...base, rating: 'down', updatedAt: '2026-03-03T00:00:00.000Z' };
    const remote = { ...base, rating: 'up', updatedAt: '2026-01-01T00:00:00.000Z' };
    const { next, remoteWins } = mergeCommissionFeedbackRecord(local, remote);
    expect(remoteWins).toBe(false);
    expect(next.rating).toBe('down');
  });

  it('drops a malformed remote (ratingless)', () => {
    const { next } = mergeCommissionFeedbackRecord({ ...base }, { id: 'cfeedback-run-1', rating: 0 });
    expect(next).toBeNull();
  });

  it('a tombstone with a newer updatedAt wins', () => {
    const local = { ...base };
    const remote = { ...base, deleted: true, deletedAt: '2026-04-04T00:00:00.000Z', updatedAt: '2026-04-04T00:00:00.000Z' };
    const { next, remoteWins } = mergeCommissionFeedbackRecord(local, remote);
    expect(remoteWins).toBe(true);
    expect(next.deleted).toBe(true);
  });
});

describe('toInlineFeedback', () => {
  it('renders the inline { id, runId, rating, note, tags, at } view directive.js consumes', () => {
    const inline = toInlineFeedback({ id: 'cfeedback-run-1', commissionId: 'c1', runId: 'run-1', rating: 'up', note: 'hi', tags: ['a'], at: '2026-01-01T00:00:00.000Z' });
    expect(inline).toEqual({ id: 'cfeedback-run-1', runId: 'run-1', rating: 'up', note: 'hi', tags: ['a'], at: '2026-01-01T00:00:00.000Z' });
    expect(inline).not.toHaveProperty('commissionId');
  });

  it('returns null for a rejected record', () => {
    expect(toInlineFeedback({ id: 'bad', rating: 'up' })).toBeNull();
  });
});
