import { describe, it, expect, vi } from 'vitest';
import { up } from './031-music-video-previz-timeline.js';

const makeClient = ({ table = 'music_video_projects', rows = [] } = {}) => {
  const updates = [];
  const query = vi.fn(async (sql, params) => {
    if (sql.includes('to_regclass')) return { rows: [{ name: table }] };
    if (sql.startsWith('SELECT')) return { rows };
    updates.push(params);
    return { rows: [] };
  });
  return { client: { query }, updates };
};

describe('db-migration 031 - music video previz timeline', () => {
  it('converts rows that still carry a night', async () => {
    const data = { concept: { subjects: [] }, previz: { cuts: [], tracks: [], night: { startClock: 600, lengthMin: 60, beats: [] } } };
    const { client, updates } = makeClient({ rows: [{ id: 'p1', data }] });
    await up(client);
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0][1]).timeline).toEqual({ startClock: 600, lengthMin: 60, beats: [] });
  });

  it('leaves converted rows and a missing table alone', async () => {
    const { client, updates } = makeClient({ rows: [{ id: 'p1', data: { previz: { cuts: [], tracks: [] } } }] });
    await up(client);
    expect(updates).toHaveLength(0);
    const none = makeClient({ table: null });
    await up(none.client);
    expect(none.updates).toHaveLength(0);
  });
});
