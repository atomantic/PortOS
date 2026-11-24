import { describe, it, expect, vi } from 'vitest';
import { migrateSongStyle, up } from './016-music-video-song-style.js';

describe('db-migration 016 - music video song style', () => {
  it('moves an untouched copy of the Suno style off the visual style', () => {
    expect(migrateSongStyle({ prompt: 'a story', style: 'synth-pop, -metal ' }, 'synth-pop, -metal'))
      .toEqual({ prompt: 'a story', style: '', songStyle: 'synth-pop, -metal' });
  });

  it('keeps a visual style the director wrote, and skips migrated or trackless projects', () => {
    expect(migrateSongStyle({ style: 'grainy 16mm' }, 'synth-pop')).toEqual({ style: 'grainy 16mm', songStyle: 'synth-pop' });
    expect(migrateSongStyle(null, 'synth-pop')).toEqual({ songStyle: 'synth-pop' });
    expect(migrateSongStyle({ songStyle: '' }, 'synth-pop')).toBeNull();
    expect(migrateSongStyle({ style: 'x' }, null)).toBeNull();
  });

  it('writes the migrated concept and does nothing without both tables', async () => {
    const updates = [];
    const query = vi.fn(async (sql, params) => {
      if (sql.includes('to_regclass')) return { rows: [{ projects: 'music_video_projects', tracks: 'tracks' }] };
      if (sql.startsWith('SELECT')) return { rows: [{ id: 'p1', concept: { style: 'pop' }, prompt: 'pop' }] };
      updates.push(params);
      return { rows: [] };
    });
    await up({ query });
    expect(updates).toEqual([['p1', JSON.stringify({ style: '', songStyle: 'pop' })]]);
    const bare = vi.fn(async () => ({ rows: [{ projects: 'music_video_projects', tracks: null }] }));
    await up({ query: bare });
    expect(bare).toHaveBeenCalledTimes(1);
  });

  it('repairs a lone surrogate split at slice(0, 2000) so jsonb accepts the bound payload', async () => {
    const updates = [];
    const promptWithSplitEmoji = `${'a'.repeat(1999)}🚀`;
    const query = vi.fn(async (sql, params) => {
      if (sql.includes('to_regclass')) return { rows: [{ projects: 'music_video_projects', tracks: 'tracks' }] };
      if (sql.startsWith('SELECT')) return { rows: [{ id: 'p1', concept: { style: 'other' }, prompt: promptWithSplitEmoji }] };
      updates.push(params);
      return { rows: [] };
    });
    await up({ query });
    expect(updates).toHaveLength(1);
    const [, rawJson] = updates[0];
    expect(rawJson).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    expect(JSON.parse(rawJson).songStyle).toBe(`${'a'.repeat(1999)}\ufffd`);
  });
});
