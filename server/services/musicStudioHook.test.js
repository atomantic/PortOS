import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildAlbumRecord, TRACK_IDS_MAX } from './albums/logic.js';
import { buildTrackRecord, makeRender } from './tracks/logic.js';
const queue = vi.hoisted(() => {
  const listeners = new Set();
  return {
    events: {
      on: (_event, handler) => listeners.add(handler),
      off: (_event, handler) => listeners.delete(handler),
      emit: (_event, job) => listeners.forEach((handler) => handler(job)),
    },
    updateJobResult: vi.fn(),
  };
});
const trackStore = vi.hoisted(() => ({ getTrack: vi.fn(), buildRenderAppend: vi.fn(), updateTrack: vi.fn(), createTrack: vi.fn() }));
const albumStore = vi.hoisted(() => ({ getAlbum: vi.fn(), updateAlbum: vi.fn() }));

vi.mock('./mediaJobQueue/index.js', () => ({ mediaJobEvents: queue.events, updateJobResult: queue.updateJobResult }));
vi.mock('./tracks/index.js', () => trackStore);
vi.mock('./albums/index.js', () => albumStore);

const { initMusicStudioHook, __testing } = await import('./musicStudioHook.js');

describe('music studio completion hook', () => {
  beforeEach(() => {
    __testing.reset();
    queue.updateJobResult.mockReset();
    trackStore.getTrack.mockReset();
    trackStore.buildRenderAppend.mockReset().mockReturnValue({ renders: [{ id: 'render-1' }] });
    trackStore.updateTrack.mockReset().mockResolvedValue({ id: 'track-1' });
    trackStore.createTrack.mockReset().mockImplementation(async (input) => ({ id: 'track-new', ...input }));
    albumStore.getAlbum.mockReset().mockResolvedValue({ id: 'album-1', trackIds: [] });
    albumStore.updateAlbum.mockReset().mockResolvedValue({});
    initMusicStudioHook();
  });

  it('attaches a completed render to an existing track and records its id', async () => {
    trackStore.getTrack.mockResolvedValue({ id: 'track-1', renders: [] });
    queue.events.emit('completed', {
      id: 'job-1', kind: 'audio', queuedAt: new Date().toISOString(),
      params: { prompt: 'fake prompt', lyrics: '[verse] fake', musicStudio: { trackId: 'track-1', lyricsEnabled: true, lyricsProvided: true } },
      result: { filename: 'fake.wav', durationSec: 12, engine: 'acestep', modelId: 'a', executionProfile: 'cuda-bf16-component-offload' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(trackStore.updateTrack).toHaveBeenCalledWith('track-1', expect.objectContaining({ audioFilename: 'fake.wav', lyrics: '[verse] fake' }));
    expect(trackStore.buildRenderAppend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      executionProfile: 'cuda-bf16-component-offload',
    }));
    expect(queue.updateJobResult).toHaveBeenCalledWith('job-1', { trackId: 'track-1' });
  });

  it('records an instrumental render without replacing saved track lyrics', async () => {
    trackStore.getTrack.mockResolvedValue({ id: 'track-1', lyrics: 'keep these words', renders: [] });
    queue.events.emit('completed', {
      id: 'job-instrumental', kind: 'audio', queuedAt: new Date().toISOString(),
      params: {
        prompt: 'warm folk\n\nInstrumental only. Do not include vocals.',
        lyrics: '',
        musicStudio: {
          trackId: 'track-1',
          authoredPrompt: 'warm folk',
          authoredLyrics: 'keep these words',
          lyricsEnabled: true,
          lyricsProvided: true,
          instrumentalOnly: true,
        },
      },
      result: { filename: 'instrumental.wav', durationSec: 60, engine: 'acestep', modelId: 'a' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(trackStore.buildRenderAppend).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'track-1' }),
      expect.objectContaining({
        prompt: expect.stringContaining('Instrumental only.'),
        authoredPrompt: 'warm folk',
        lyrics: '',
        instrumentalOnly: true,
      }),
    );
    const update = trackStore.updateTrack.mock.calls[0][1];
    expect(update.prompt).toBe('warm folk');
    expect(update).not.toHaveProperty('lyrics');
    expect(queue.updateJobResult).toHaveBeenCalledWith('job-instrumental', { trackId: 'track-1' });
  });

  it('keeps authored lyrics when an instrumental render creates a standalone track', async () => {
    queue.events.emit('completed', {
      id: 'job-standalone-instrumental', kind: 'audio', queuedAt: new Date().toISOString(),
      params: {
        prompt: 'cinematic score\n\nInstrumental only. Do not include vocals.',
        lyrics: '',
        musicStudio: {
          trackId: null,
          title: 'Fake score',
          authoredPrompt: 'cinematic score',
          authoredLyrics: '[verse]\nSaved draft words',
          lyricsEnabled: true,
          lyricsProvided: true,
          instrumentalOnly: true,
        },
      },
      result: { filename: 'standalone.wav', durationSec: 60, engine: 'acestep', modelId: 'a' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(trackStore.createTrack).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Fake score',
      prompt: 'cinematic score',
      lyrics: '[verse]\nSaved draft words',
    }));
  });

  it('creates a standalone track, appends its album, and does not crash when target is deleted', async () => {
    trackStore.createTrack.mockResolvedValue({ id: 'track-new', albumId: 'album-1' });
    queue.events.emit('completed', {
      id: 'job-2', kind: 'audio', queuedAt: new Date().toISOString(),
      params: { prompt: 'fake prompt', musicStudio: { trackId: null, title: 'Fake song', albumId: 'album-1' } },
      result: { filename: 'fake.wav', durationSec: 8, engine: 'musicgen', modelId: 'm' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(trackStore.createTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Fake song', albumId: 'album-1' }));
    expect(albumStore.updateAlbum).toHaveBeenCalledWith('album-1', { trackIds: ['track-new'] });

    trackStore.getTrack.mockResolvedValue(null);
    queue.events.emit('completed', {
      id: 'job-3', kind: 'audio', queuedAt: new Date().toISOString(),
      params: { prompt: 'fake prompt', musicStudio: { trackId: 'deleted-track' } },
      result: { filename: 'orphan.wav' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(trackStore.updateTrack).not.toHaveBeenCalledWith('deleted-track', expect.anything());
  });

  it.each(['full', 'missing'])('preserves completed audio as an unassigned track when the album is %s', async (state) => {
    const now = '2026-01-01T00:00:00.000Z';
    const album = state === 'full' ? buildAlbumRecord({
      title: 'Example Album', trackIds: Array.from({ length: TRACK_IDS_MAX }, (_, i) => `track-example-${i}`),
    }, { id: 'album-1', now }) : null;
    albumStore.getAlbum.mockResolvedValue(album);
    let storedTrack;
    trackStore.createTrack.mockImplementation(async (input) => {
      storedTrack = buildTrackRecord(input, { id: 'track-new', now });
      return storedTrack;
    });
    trackStore.buildRenderAppend.mockImplementation((_track, input) => ({
      renders: [makeRender(input, { id: 'render-new', now })],
    }));
    queue.events.emit('completed', {
      id: 'job-preserved', kind: 'audio', queuedAt: now,
      params: { prompt: 'Example prompt', musicStudio: { trackId: null, title: 'Example Track', albumId: 'album-1' } },
      result: { filename: 'completed.wav', durationSec: 8, engine: 'musicgen', modelId: 'example-model' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(storedTrack).toMatchObject({ id: 'track-new', albumId: '', audioFilename: 'completed.wav' });
    expect(storedTrack.renders).toEqual([expect.objectContaining({ audioFilename: 'completed.wav' })]);
    expect(albumStore.updateAlbum).not.toHaveBeenCalled();
    expect(queue.updateJobResult).toHaveBeenCalledWith('job-preserved', {
      trackId: 'track-new',
      albumAssignmentError: { code: state === 'full' ? 'ALBUM_FULL' : 'ALBUM_NOT_FOUND', message: expect.any(String) },
    });
  });

  it('files the privacy-safe profile prompt instead of the rollback-safe empty prompt', async () => {
    trackStore.getTrack.mockResolvedValue({ id: 'track-1', renders: [] });
    queue.events.emit('completed', {
      id: 'job-remote', kind: 'audio', queuedAt: new Date().toISOString(),
      params: {
        prompt: '',
        lyrics: '',
        remoteMedia: {
          wireVersion: 1,
          peerId: '00000000-0000-4000-8000-000000000001',
          profile: { style: 'ambient', mood: 'calm', tempo: 'slow', energy: 'low', instruments: ['piano'] },
          request: { engine: 'remote-audio', modelId: 'example/model' },
        },
        musicStudio: { trackId: 'track-1', lyricsEnabled: true, lyricsProvided: false },
      },
      result: { filename: 'remote.wav', durationSec: 30, engine: 'remote-audio', modelId: 'example/model' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(trackStore.buildRenderAppend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      prompt: 'Instrumental ambient music with a calm mood, slow tempo, low energy, featuring piano. No vocals or spoken words.',
      lyrics: '',
    }));
  });
});
