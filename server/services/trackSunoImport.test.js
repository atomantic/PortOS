import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/ffmpeg.js', () => ({ probeVideoDuration: vi.fn(async () => 200) }));
vi.mock('./pipeline/musicLibrary.js', () => ({
  importUploadedTrack: vi.fn(async () => ({ filename: 'music-suno.mp3', sizeBytes: 10 })),
  MUSIC_UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
}));
vi.mock('./tracks/index.js', () => ({ createTrack: vi.fn(async (input) => ({ id: 'track-new', ...input })) }));
vi.mock('../lib/sseUtils.js', () => ({ broadcastSse: vi.fn(), attachSseClient: vi.fn(() => true), closeJobAfterDelay: vi.fn() }));
vi.mock('../lib/safeUrlFetch.js', () => ({ fetchPublicText: vi.fn(), fetchPublicBinary: vi.fn(), resolvePublicUrl: vi.fn() }));

const { broadcastSse } = await import('../lib/sseUtils.js');
const { probeVideoDuration } = await import('../lib/ffmpeg.js');
const { fetchPublicText, fetchPublicBinary, resolvePublicUrl } = await import('../lib/safeUrlFetch.js');
const { importUploadedTrack } = await import('./pipeline/musicLibrary.js');
const { createTrack } = await import('./tracks/index.js');
const { startSunoImport, cancelSunoImport } = await import('./trackSunoImport.js');

const ID = '11111111-2222-4333-8444-555555555555';
const songPage = (record) => `<script>self.__next_f.push([1,${JSON.stringify(`5:${JSON.stringify(record)}\n`)}])</script>`;

// The terminal frame the detached job broadcast, once it lands.
const terminal = () => vi.waitFor(() => {
  const frame = broadcastSse.mock.calls.map(([, f]) => f).find((f) => ['complete', 'error', 'canceled'].includes(f.type));
  expect(frame).toBeTruthy();
  return frame;
});

beforeEach(() => {
  vi.clearAllMocks();
  probeVideoDuration.mockResolvedValue(200);
  fetchPublicBinary.mockResolvedValue({ buffer: Buffer.from('ID3audio'), contentType: 'audio/mpeg' });
});

describe('startSunoImport', () => {
  it('imports the audio as a Suno take with the title, lyrics and style from the song page', async () => {
    fetchPublicText.mockResolvedValue(songPage({
      id: ID, title: 'Airplane Mode', audio_url: `https://cdn1.suno.ai/${ID}.mp3`,
      metadata: { prompt: '[Verse]\nno signal', tags: 'dream pop' },
    }));
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'complete', trackId: 'track-new', source: 'suno' });
    expect(fetchPublicBinary).toHaveBeenCalledWith(`https://cdn1.suno.ai/${ID}.mp3`, expect.any(Object));
    expect(importUploadedTrack).toHaveBeenCalledWith(expect.stringMatching(/song\.mp3$/), 'Airplane Mode.mp3');
    expect(createTrack).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Airplane Mode', lyrics: '[Verse]\nno signal', prompt: 'dream pop', durationSec: 200,
      renders: [expect.objectContaining({ source: 'suno', lyrics: '[Verse]\nno signal', prompt: 'dream pop' })],
    }));
  });

  it('still imports the audio from Suno\'s CDN when the page cannot be read', async () => {
    fetchPublicText.mockResolvedValue(null);
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'complete' });
    expect(fetchPublicBinary).toHaveBeenCalledWith(`https://cdn1.suno.ai/${ID}.mp3`, expect.any(Object));
    expect(createTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Suno song', lyrics: '' }));
  });

  it('follows a share link only on Suno\'s own hosts', async () => {
    resolvePublicUrl.mockResolvedValue(`https://suno.com/song/${ID}`);
    fetchPublicText.mockResolvedValue(null);
    await startSunoImport('https://suno.com/s/AbCdEf123456');
    expect(await terminal()).toMatchObject({ type: 'complete' });
    const { allowUrl } = resolvePublicUrl.mock.calls[0][1];
    expect(allowUrl(new URL('https://suno.com/song/x'))).toBe(true);
    expect(allowUrl(new URL('https://example.com/song/x'))).toBe(false);
    expect(fetchPublicText).toHaveBeenCalledWith(`https://suno.com/song/${ID}`, expect.any(Object));
  });

  it('reports an error when the audio cannot be downloaded, creating no track', async () => {
    fetchPublicText.mockResolvedValue(null);
    fetchPublicBinary.mockResolvedValue(null);
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'error', error: expect.stringMatching(/Could not download/) });
    expect(createTrack).not.toHaveBeenCalled();
  });

  it.each([
    ['an HTML page', { buffer: Buffer.from('<html>Just a moment…</html>'), contentType: 'text/html; charset=utf-8' }, /other than audio/],
    ['an unplayable file', { buffer: Buffer.from('garbage'), contentType: 'audio/mpeg' }, /not playable audio/],
  ])('refuses %s as the song audio, creating no track', async (_label, body, message) => {
    fetchPublicText.mockResolvedValue(null);
    fetchPublicBinary.mockResolvedValue(body);
    probeVideoDuration.mockResolvedValueOnce(null);
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'error', error: expect.stringMatching(message) });
    expect(importUploadedTrack).not.toHaveBeenCalled();
  });

  it('ends as cancelled, creating no track, when cancelled mid-download', async () => {
    fetchPublicText.mockResolvedValue(null);
    let release;
    fetchPublicBinary.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { jobId } = await startSunoImport(`https://suno.com/song/${ID}`);
    await vi.waitFor(() => expect(fetchPublicBinary).toHaveBeenCalled());
    expect(cancelSunoImport(jobId)).toBe(true);
    expect(cancelSunoImport(jobId)).toBe(false);
    release({ buffer: Buffer.from('x'), contentType: 'audio/mpeg' });
    expect(await terminal()).toEqual({ type: 'canceled' });
    expect(importUploadedTrack).not.toHaveBeenCalled();
  });

  it('refuses a link that is not a Suno song', async () => {
    await expect(startSunoImport('https://example.com/song/x')).rejects.toMatchObject({ status: 400, code: 'SUNO_URL_INVALID' });
  });
});
