import { describe, expect, it, vi } from 'vitest';

vi.mock('../htmlComposition/index.js', () => ({ renderComposition: vi.fn(async () => ({ generationId: 'job-1' })) }));

const { renderSongComposition } = await import('./compositionRender.js');
const { renderComposition } = await import('../htmlComposition/index.js');

describe('renderSongComposition', () => {
  it('calls the music-video owner with the master in-point and a null feature block', async () => {
    const project = {
      audioAnalysis: {
        durationSec: 180, beats: [0, 0.5], downbeats: [0],
        sections: [{ label: 'verse', startSec: 0, endSec: 8 }],
        features: [],
      },
      lyricCues: [{ text: 'go on', words: [{ w: 'go', startSec: 1, endSec: 1.2, conf: 'matched' }] }],
    };
    await renderSongComposition({
      project, directory: 'compositions/example', jobId: 'job-1', audioPath: '/data/music/song.wav', startSec: 60,
    });
    expect(renderComposition).toHaveBeenCalledWith({
      jobId: 'job-1',
      directory: 'compositions/example',
      owner: 'music-video',
      audio: { path: '/data/music/song.wav', startSec: 60 },
      maxDurationSec: 180,
      song: {
        beats: [0, 0.5],
        downbeats: [0],
        sections: [{ label: 'verse', startSec: 0, endSec: 8 }],
        features: null,
        words: [{ w: 'go', startSec: 1, endSec: 1.2, conf: 'matched' }],
      },
    });
  });

  it('leaves word timings null when no cue has been aligned', async () => {
    renderComposition.mockClear();
    await renderSongComposition({
      project: { audioAnalysis: { durationSec: 30, beats: [], downbeats: [], sections: [] }, lyricCues: [{ text: 'go' }] },
      directory: 'compositions/example', jobId: 'job-2', audioPath: '/data/music/song.wav',
    });
    expect(renderComposition.mock.calls[0][0].song.words).toBeNull();
    expect(renderComposition.mock.calls[0][0].audio.startSec).toBe(0);
  });
});
