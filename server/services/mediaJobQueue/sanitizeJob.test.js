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

  it('restores the public prompt without exposing private peer routing fields', () => {
    const sanitized = sanitizeJob({
      id: 'job-example',
      kind: 'audio',
      status: 'queued',
      params: {
        prompt: '',
        modelId: 'example/model',
        remoteMedia: {
          wireVersion: 1,
          peerId: '00000000-0000-4000-8000-000000000001',
          profile: {
            style: 'orchestral',
            mood: 'triumphant',
            tempo: 'moderate',
            energy: 'high',
            instruments: ['brass', 'strings'],
          },
          request: {
            engine: 'remote-audio',
            modelId: 'example/model',
          },
        },
      },
    });

    expect(sanitized.params).toEqual({
      prompt: 'Instrumental orchestral music with a triumphant mood, moderate tempo, high energy, featuring brass and strings. No vocals or spoken words.',
      modelId: 'example/model',
    });
    expect(sanitized.params).not.toHaveProperty('remoteMedia');
  });
});
