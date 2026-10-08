import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/ffmpeg.js', () => ({
  probeVideoDuration: vi.fn(async () => 200),
  findFfmpeg: vi.fn(async () => '/usr/local/bin/ffmpeg'),
  runFfmpegProcess: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./pipeline/musicLibrary.js', () => ({
  importUploadedTrack: vi.fn(async () => ({ filename: 'music-suno.mp3', sizeBytes: 10 })),
  MUSIC_UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
}));
vi.mock('./tracks/index.js', () => ({ createTrack: vi.fn(async (input) => ({ id: 'track-new', ...input })) }));
vi.mock('../lib/sseUtils.js', () => ({ broadcastSse: vi.fn(), attachSseClient: vi.fn(() => true), closeJobAfterDelay: vi.fn() }));
vi.mock('./musicVideo/autonomousSuno.js', () => ({ generateSunoSong: vi.fn() }));
vi.mock('../lib/safeUrlFetch.js', () => ({ fetchPublicText: vi.fn(), fetchPublicBinary: vi.fn(), resolvePublicUrl: vi.fn() }));

const { broadcastSse } = await import('../lib/sseUtils.js');
const { probeVideoDuration, runFfmpegProcess } = await import('../lib/ffmpeg.js');
const { fetchPublicText, fetchPublicBinary, resolvePublicUrl } = await import('../lib/safeUrlFetch.js');
const { importUploadedTrack } = await import('./pipeline/musicLibrary.js');
const { generateSunoSong } = await import('./musicVideo/autonomousSuno.js');
const { createTrack } = await import('./tracks/index.js');
const { startSunoImport, cancelSunoImport, __testing } = await import('./trackSunoImport.js');

const ID = '11111111-2222-4333-8444-555555555555';
const songPage = (record) => `<script>self.__next_f.push([1,${JSON.stringify(`5:${JSON.stringify(record)}\n`)}])</script>`;

// A browser export that lands a file through the import's importAudio.
const exportsFile = (page) => async (_fields, deps) => {
  if (page) deps.onSongPage(page);
  const { mkdtemp, writeFile, rm } = await import('fs/promises');
  const srcDir = await mkdtemp(`${(await import('os')).tmpdir()}/suno-test-`);
  await writeFile(`${srcDir}/song.m4a`, 'm4a');
  await deps.importAudio(`${srcDir}/song.m4a`, 'song.m4a').finally(() => rm(srcDir, { recursive: true, force: true }));
  return { songId: ID };
};

// The terminal frame the detached job broadcast, once it lands.
const terminal = () => vi.waitFor(() => {
  const frame = broadcastSse.mock.calls.map(([, f]) => f).find((f) => ['complete', 'error', 'canceled'].includes(f.type));
  expect(frame).toBeTruthy();
  return frame;
});

beforeEach(() => {
  vi.clearAllMocks();
  probeVideoDuration.mockResolvedValue(200);
  runFfmpegProcess.mockResolvedValue({ ok: true });
  generateSunoSong.mockRejectedValue(new Error('Sign in to Suno in the PortOS Browser'));
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
    expect(await terminal()).toMatchObject({ type: 'error', error: expect.stringMatching(/would not hand over/) });
    expect(createTrack).not.toHaveBeenCalled();
  });

  it.each([
    ['an HTML page', { buffer: Buffer.from('<html>Just a moment…</html>'), contentType: 'text/html; charset=utf-8' }, /would not hand over/],
    ['an unplayable file', { buffer: Buffer.from('garbage'), contentType: 'audio/mpeg' }, /not playable audio/],
  ])('refuses %s as the song audio, creating no track', async (_label, body, message) => {
    fetchPublicText.mockResolvedValue(null);
    fetchPublicBinary.mockResolvedValue(body);
    probeVideoDuration.mockResolvedValue(null);
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'error', error: expect.stringMatching(message) });
    expect(importUploadedTrack).not.toHaveBeenCalled();
  });

  it('exports a private song through the signed-in browser, taking its title and lyrics from that page', async () => {
    fetchPublicText.mockResolvedValue(null); // the anonymous page shows nothing for a private song
    fetchPublicBinary.mockResolvedValue(null);
    generateSunoSong.mockImplementation(exportsFile(songPage({ id: ID, title: 'Unreleased', metadata: { prompt: 'draft words', tags: 'lo-fi' } })));
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'complete' });
    expect(generateSunoSong).toHaveBeenCalledWith({}, expect.objectContaining({ songIds: [ID], signal: expect.any(AbortSignal), timeoutMs: 90_000 }));
    expect(fetchPublicBinary.mock.calls.map(([url]) => url)).not.toContain(`https://cdn1.suno.ai/${ID}.mp4`);
    expect(importUploadedTrack).toHaveBeenCalledWith(expect.stringMatching(/song\.m4a$/), 'Unreleased.m4a');
    expect(createTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unreleased', lyrics: 'draft words', prompt: 'lo-fi' }));
  });

  it('takes the audio out of the public video when Suno withholds the audio file', async () => {
    // Suno's live page names an API placeholder rather than media, and the mp3 403s.
    fetchPublicText.mockResolvedValue(songPage({
      id: ID, title: 'Airplane Mode', audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
      metadata: { prompt: '[Verse]\nno signal', tags: 'dream pop' },
    }));
    fetchPublicBinary.mockImplementation(async (url) => (url.endsWith('.mp4')
      ? { buffer: Buffer.from('mp4bytes'), contentType: 'video/mp4' }
      : null));
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'complete' });
    expect(fetchPublicBinary.mock.calls.map(([url]) => url)).toEqual([
      `https://cdn1.suno.ai/${ID}.mp3`, `https://cdn1.suno.ai/${ID}.mp4`,
    ]);
    expect(runFfmpegProcess).toHaveBeenCalledWith({ bin: '/usr/local/bin/ffmpeg', signal: expect.any(AbortSignal), args: expect.arrayContaining(['-vn', '-c:a', 'copy']) });
    expect(importUploadedTrack).toHaveBeenCalledWith(expect.stringMatching(/song\.m4a$/), 'Airplane Mode.m4a');
    expect(createTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Airplane Mode', lyrics: '[Verse]\nno signal' }));
    // A public song takes the fast public-video route, never the browser queue.
    expect(generateSunoSong).not.toHaveBeenCalled();
  });

  it('exports a public song through the browser when its public video is refused', async () => {
    fetchPublicText.mockResolvedValue(songPage({ id: ID, title: 'Airplane Mode', metadata: { prompt: 'words', tags: 'pop' } }));
    fetchPublicBinary.mockResolvedValue(null); // mp3 and mp4 both refused
    generateSunoSong.mockImplementation(exportsFile(null));
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'complete' });
    expect(generateSunoSong).toHaveBeenCalled();
    expect(createTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Airplane Mode', lyrics: 'words' }));
  });

  it('keeps progress moving forward when the browser export follows a failed extraction', async () => {
    fetchPublicText.mockResolvedValue(songPage({ id: ID, title: 'Airplane Mode' }));
    fetchPublicBinary.mockImplementation(async (url) => (url.endsWith('.mp4') ? { buffer: Buffer.from('v'), contentType: 'video/mp4' } : null));
    runFfmpegProcess.mockResolvedValue({ ok: false, reason: 'no audio stream' });
    generateSunoSong.mockImplementation(exportsFile(null));
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'complete' });
    const percents = broadcastSse.mock.calls.map(([, f]) => f).filter((f) => f.type === 'progress').map((f) => f.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it('falls back to the public video when the browser export waits past its budget', async () => {
    const { browserWaitMs } = __testing.limits;
    __testing.limits.browserWaitMs = 20;
    try {
      fetchPublicText.mockResolvedValue(null); // private-looking page: the browser goes first
      fetchPublicBinary.mockImplementation(async (url) => (url.endsWith('.mp4') ? { buffer: Buffer.from('v'), contentType: 'video/mp4' } : null));
      let exportSignal;
      generateSunoSong.mockImplementation((_fields, deps) => { exportSignal = deps.signal; return new Promise(() => {}); });
      await startSunoImport(`https://suno.com/song/${ID}`);
      expect(await terminal()).toMatchObject({ type: 'complete' });
      expect(fetchPublicBinary.mock.calls.map(([url]) => url)).toContain(`https://cdn1.suno.ai/${ID}.mp4`);
      // The still-queued export is told to stand down.
      expect(exportSignal.aborted).toBe(true);
    } finally {
      __testing.limits.browserWaitMs = browserWaitMs;
    }
  });

  it('cancels at once while the browser export waits its turn in the shared browser queue', async () => {
    fetchPublicText.mockResolvedValue(null); // private song: the browser export goes first
    fetchPublicBinary.mockResolvedValue(null);
    generateSunoSong.mockImplementation(() => new Promise(() => {})); // queued behind another browser job
    const { jobId } = await startSunoImport(`https://suno.com/song/${ID}`);
    await vi.waitFor(() => expect(generateSunoSong).toHaveBeenCalled());
    expect(cancelSunoImport(jobId)).toBe(true);
    expect(await terminal()).toEqual({ type: 'canceled' });
    expect(fetchPublicBinary.mock.calls.map(([url]) => url)).not.toContain(`https://cdn1.suno.ai/${ID}.mp4`);
  });

  it('transcodes when the video\'s audio track will not copy, and fails when nothing will', async () => {
    fetchPublicText.mockResolvedValue(null);
    fetchPublicBinary.mockImplementation(async (url) => (url.endsWith('.mp4') ? { buffer: Buffer.from('v'), contentType: 'video/mp4' } : null));
    runFfmpegProcess.mockResolvedValueOnce({ ok: false, reason: 'copy failed' });
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'complete' });
    expect(runFfmpegProcess.mock.calls[1][0].args).toEqual(expect.arrayContaining(['-c:a', 'aac']));

    vi.clearAllMocks();
    probeVideoDuration.mockResolvedValue(200);
    runFfmpegProcess.mockResolvedValue({ ok: false, reason: 'no audio stream' });
    await startSunoImport(`https://suno.com/song/${ID}`);
    expect(await terminal()).toMatchObject({ type: 'error', error: expect.stringMatching(/take the audio out/) });
    expect(createTrack).not.toHaveBeenCalled();
  });

  it('stops the audio extraction when cancelled during it', async () => {
    fetchPublicText.mockResolvedValue(null);
    fetchPublicBinary.mockImplementation(async (url) => (url.endsWith('.mp4') ? { buffer: Buffer.from('v'), contentType: 'video/mp4' } : null));
    runFfmpegProcess.mockImplementation(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled (SIGTERM)' }));
    }));
    const { jobId } = await startSunoImport(`https://suno.com/song/${ID}`);
    await vi.waitFor(() => expect(runFfmpegProcess).toHaveBeenCalled());
    expect(cancelSunoImport(jobId)).toBe(true);
    expect(await terminal()).toEqual({ type: 'canceled' });
    expect(runFfmpegProcess).toHaveBeenCalledTimes(1); // no transcode retry after a cancel
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
