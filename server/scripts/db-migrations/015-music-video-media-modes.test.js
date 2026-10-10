import { describe, it, expect, vi } from 'vitest';
import { up } from './015-music-video-media-modes.js';

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

describe('db-migration 015 - music video media modes', () => {
  it('pins mediaMode on rows lacking it', async () => {
    const { client, updates } = makeClient({ rows: [{ id: 'p1', data: { scenes: [] } }] });
    await up(client);
    expect(updates).toEqual([['p1', 'code-images-video']]);
  });

  it('does nothing when the table is absent', async () => {
    const { client, updates } = makeClient({ table: null });
    await up(client);
    expect(updates).toHaveLength(0);
  });
});
