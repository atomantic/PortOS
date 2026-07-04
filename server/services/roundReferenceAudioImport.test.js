import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServerError } from '../lib/errorHandler.js';

vi.mock('../lib/safeUrlFetch.js', () => ({ assertPublicHttpUrl: vi.fn(async () => {}) }));
vi.mock('../lib/sseUtils.js', () => ({
  broadcastSse: vi.fn(),
  attachSseClient: vi.fn(() => true),
  closeJobAfterDelay: vi.fn(),
}));
vi.mock('../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn() }));
vi.mock('./ytdlpAudioImport.js', () => ({
  resolveYtDlpBinaries: vi.fn(async () => ({ ytDlp: '/yt', ffmpeg: '/ff' })),
  downloadAudioToTempMp3: vi.fn(),
  cleanupYtDlpTemp: vi.fn(async () => {}),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  importFileToUploads: vi.fn(async () => ({ filename: 'ab12cd34-Reference_Audio.mp3', sizeBytes: 100 })),
}));

const { assertPublicHttpUrl } = await import('../lib/safeUrlFetch.js');
const { broadcastSse } = await import('../lib/sseUtils.js');
const { resolveYtDlpBinaries, downloadAudioToTempMp3, cleanupYtDlpTemp } = await import('./ytdlpAudioImport.js');
const { importFileToUploads } = await import('../lib/fileUtils.js');
const { startReferenceAudioImport } = await import('./roundReferenceAudioImport.js');

// Let the detached kickoff IIFE run to its terminal broadcast.
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  vi.clearAllMocks();
  assertPublicHttpUrl.mockResolvedValue(undefined);
  resolveYtDlpBinaries.mockResolvedValue({ ytDlp: '/yt', ffmpeg: '/ff' });
});

describe('startReferenceAudioImport — pre-kickoff guards', () => {
  it('rejects an unsafe URL before touching yt-dlp discovery', async () => {
    assertPublicHttpUrl.mockRejectedValue(new ServerError('unsafe', { status: 400, code: 'UNSAFE_URL' }));
    await expect(startReferenceAudioImport('http://127.0.0.1/x'))
      .rejects.toMatchObject({ status: 400, code: 'UNSAFE_URL' });
    expect(resolveYtDlpBinaries).not.toHaveBeenCalled();
  });

  it('applies the strict SSRF posture (blockPrivate) so LAN hosts are rejected', async () => {
    downloadAudioToTempMp3.mockResolvedValue({ outcome: 'canceled' });
    await startReferenceAudioImport('https://example.com/clip');
    await flush();
    expect(assertPublicHttpUrl).toHaveBeenCalledWith('https://example.com/clip', { blockPrivate: true });
  });
});

describe('startReferenceAudioImport — outcomes', () => {
  it('lands the mp3 in uploads and broadcasts complete with the filename', async () => {
    downloadAudioToTempMp3.mockResolvedValue({ outcome: 'complete', outPath: '/tmp/x.mp3', title: 'My Clip' });
    const { jobId } = await startReferenceAudioImport('https://example.com/clip');
    expect(jobId).toBeTruthy();
    await flush();

    expect(importFileToUploads).toHaveBeenCalledWith('/tmp/x.mp3', 'My Clip.mp3');
    expect(broadcastSse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'complete', filename: 'ab12cd34-Reference_Audio.mp3' }),
    );
  });

  it('falls back to a default title when yt-dlp reported none', async () => {
    downloadAudioToTempMp3.mockResolvedValue({ outcome: 'complete', outPath: '/tmp/x.mp3', title: '' });
    await startReferenceAudioImport('https://example.com/clip');
    await flush();
    expect(importFileToUploads).toHaveBeenCalledWith('/tmp/x.mp3', 'Reference Audio.mp3');
  });

  it('broadcasts error and cleans temp on a failed download', async () => {
    downloadAudioToTempMp3.mockResolvedValue({ outcome: 'failed', reason: 'no audio was produced' });
    await startReferenceAudioImport('https://example.com/clip');
    await flush();
    expect(broadcastSse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'error', error: 'no audio was produced' }));
    expect(cleanupYtDlpTemp).toHaveBeenCalled();
    expect(importFileToUploads).not.toHaveBeenCalled();
  });

  it('broadcasts canceled when the download was cancelled', async () => {
    downloadAudioToTempMp3.mockResolvedValue({ outcome: 'canceled' });
    await startReferenceAudioImport('https://example.com/clip');
    await flush();
    expect(broadcastSse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'canceled' }));
    expect(importFileToUploads).not.toHaveBeenCalled();
  });
});
