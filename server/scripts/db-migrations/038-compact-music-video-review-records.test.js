import { describe, it, expect, vi } from 'vitest';
import { up } from './038-compact-music-video-review-records.js';

const lock = { approvedAt: '2026-01-01T00:00:00.000Z', basis: 'still-1', v: 2, reviewer: 'director', fromBoardApproval: true };
const approval = { stage: 'storyboard', basis: 'board-1', inputs: { shots: 'hash' }, values: { shots: 'text' } };
// A lock written before shot locks were compacted: the whole board approval copied into it.
const bloated = { approvals: { storyboard: approval }, shotApprovals: { s1: { ...approval, ...lock }, s2: { approvedAt: lock.approvedAt, basis: 'still-2', v: 2 } } };

const makeClient = ({ table = 'music_video_projects', reviews = {} } = {}) => {
  const updates = [];
  const query = vi.fn(async (sql, params) => {
    if (sql.includes('to_regclass')) return { rows: [{ name: table }] };
    if (sql.startsWith('SELECT id ')) return { rows: Object.keys(reviews).map((id) => ({ id })) };
    if (sql.startsWith('SELECT')) return { rows: [{ productionReview: structuredClone(reviews[params[0]]) }] };
    updates.push({ sql, id: params[0], review: JSON.parse(params[1]) });
    return { rows: [] };
  });
  return { client: { query }, updates };
};

describe('db-migration 038 - compact music video review records', () => {
  it('strips the copied board approval from shot locks and leaves the approvals and own locks alone', async () => {
    const current = { approvals: { storyboard: approval }, shotApprovals: { s1: lock } };
    const { client, updates } = makeClient({ reviews: { 'mv-old': bloated, 'mv-current': current } });
    await up(client);
    expect(updates.map((u) => u.id)).toEqual(['mv-old']);
    // Only the review is replaced, so scenes and update timestamps stay as stored.
    expect(updates[0].sql).toContain("jsonb_set(data, '{productionReview}'");
    expect(updates[0].sql).not.toContain('updated_at');
    expect(updates[0].review).toEqual({ approvals: bloated.approvals, shotApprovals: { s1: lock, s2: bloated.shotApprovals.s2 } });
  });

  it('does nothing on an install without the table', async () => {
    const { client, updates } = makeClient({ table: null, reviews: { 'mv-old': bloated } });
    await up(client);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
  });
});
