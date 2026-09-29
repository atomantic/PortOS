import { describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'),
  safeUnder: (root, name) => (name ? `${root}/${name}` : null),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  probeVideoDuration: vi.fn(async () => 30),
  probeVideoGeometry: vi.fn(async () => null),
}));
vi.mock('../videoGen/local.js', () => ({ loadHistory: vi.fn(), saveHistory: vi.fn(async () => {}), mutateVideoHistory: vi.fn() }));
vi.mock('../tracks/index.js', () => ({ getTrack: vi.fn() }));
vi.mock('./projects.js', () => ({ getProject: vi.fn(), updateProject: vi.fn(async () => ({})), listProjects: vi.fn(async () => []), mutateProjectRecord: vi.fn() }));
vi.mock('./compositionRender.js', () => ({
  renderTypographyOverlays: vi.fn(),
  removeCompositionScratch: vi.fn(),
  sweepCompositionScratch: vi.fn(),
  renderSongComposition: vi.fn(async () => ({ generationId: 'song-job' })),
}));

import { getProject } from './projects.js';
import { getTrack } from '../tracks/index.js';
import { renderSongComposition } from './compositionRender.js';
import { renderMusicVideo } from './render.js';

describe('renderMusicVideo code composition', () => {
  it('passes the composition directory and excerpt in-point to the song renderer', async () => {
    getProject.mockResolvedValue({ id: 'p1', trackId: 't1', audioAnalysis: { durationSec: 180 } });
    getTrack.mockResolvedValue({ audioFilename: 'song.wav' });
    const result = await renderMusicVideo('p1', { codeDirectory: 'compositions/song', startSec: 60 });
    expect(result).toEqual({ generationId: 'song-job' });
    expect(renderSongComposition).toHaveBeenCalledWith(expect.objectContaining({
      directory: 'compositions/song',
      audioPath: expect.stringContaining('song.wav'),
      startSec: 60,
      project: expect.objectContaining({ id: 'p1' }),
    }));
  });

  it('keeps a second code render off the project while the first is in flight', async () => {
    getProject.mockResolvedValue({ id: 'p2', uploadedAudioFilename: 'take.wav', audioAnalysis: { durationSec: 90 } });
    let release;
    renderSongComposition.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = renderMusicVideo('p2', { codeDirectory: 'compositions/song' });
    await vi.waitFor(() => expect(renderSongComposition).toHaveBeenCalled());
    await expect(renderMusicVideo('p2', { codeDirectory: 'compositions/song' })).rejects.toMatchObject({ status: 409, code: 'RENDER_IN_PROGRESS' });
    release({ generationId: 'done' });
    await first;
  });
});
