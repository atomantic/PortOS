import { describe, expect, it } from 'vitest';
import { withYoutubeTab } from './youtubeBrowserLock.js';

describe('withYoutubeTab', () => {
  it('runs jobs one at a time in arrival order and survives a failing job', async () => {
    const log = [];
    const job = (name, fail) => withYoutubeTab(async () => {
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`${name}:end`);
      if (fail) throw new Error('boom');
      return name;
    });
    const results = await Promise.allSettled([job('history', true), job('playlists')]);
    expect(log).toEqual(['history:start', 'history:end', 'playlists:start', 'playlists:end']);
    expect(results[0].status).toBe('rejected');
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'playlists' });
  });
});
