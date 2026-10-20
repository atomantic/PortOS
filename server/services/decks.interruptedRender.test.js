/**
 * Read-time projection for a deck card render a restart interrupted (#12619).
 * The queue archives the job without a terminal event; the detail read fails
 * the stamp. No database: the persist path keeps jobId and both clocks.
 */
import { describe, expect, it } from 'vitest';
import { projectInterruptedCardRenders } from './decks.js';

const card = (render) => ({ id: 'card-1', prompt: 'a queen', render });

describe('projectInterruptedCardRenders', () => {
  it('fails a queued card whose job is gone and keeps the job id', () => {
    const queued = card({ jobId: 'job-dead', status: 'queued', queuedAt: '2026-01-01T00:00:00.000Z' });
    const dead = projectInterruptedCardRenders([queued], () => false);
    expect(dead.changed).toBe(true);
    expect(dead.updates).toEqual([{ id: 'card-1', jobId: 'job-dead' }]);
    expect(dead.cards[0].render).toMatchObject({ jobId: 'job-dead', status: 'failed', error: 'interrupted by restart' });
  });

  it('leaves a live job, a finished card, and a card with no render', () => {
    const cards = [
      card({ jobId: 'job-live', status: 'queued' }),
      card({ jobId: 'job-done', status: 'completed' }),
      { id: 'card-2', prompt: 'a king', render: null },
    ];
    expect(projectInterruptedCardRenders(cards, (jobId) => jobId === 'job-live')).toEqual({ cards, changed: false, updates: [] });
  });

  it('fails a queued stamp that never received a job id', () => {
    const queued = card({ status: 'queued', queuedAt: '2026-01-01T00:00:00.000Z' });
    const dead = projectInterruptedCardRenders([queued], () => true);
    expect(dead.changed).toBe(true);
    expect(dead.cards[0].render).toMatchObject({ status: 'failed', error: 'interrupted by restart' });
    expect(dead.updates).toEqual([{ id: 'card-1', jobId: '' }]);
  });
});
