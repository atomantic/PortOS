import { describe, expect, it } from 'vitest';
import { sanitizeJob } from './sanitizeJob.js';

describe('sanitizeJob', () => {
  it('exposes instrumental mode without leaking authored Music Studio text', () => {
    const job = sanitizeJob({
      id: 'job-1',
      kind: 'audio',
      status: 'running',
      params: {
        prompt: 'safe conditioning prompt',
        lyrics: 'private lyric draft',
        musicStudio: {
          trackId: 'track-1',
          authoredPrompt: 'private source prompt',
          authoredLyrics: 'private lyric draft',
          instrumentalOnly: true,
        },
      },
    });

    expect(job.params.musicStudio).toEqual({ trackId: 'track-1', instrumentalOnly: true });
    expect(job.params).not.toHaveProperty('lyrics');
  });
});
