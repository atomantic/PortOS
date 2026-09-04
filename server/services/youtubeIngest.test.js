import { describe, it, expect, vi, beforeEach } from 'vitest';

// The ingest module pulls in the brain/cos/media graphs at import time for its
// spawn path. Stub the heavy edges so this suite exercises the service-level
// contracts (URL gate, cancel) without a live store. The pure formatting and
// parsing contracts moved to `lib/youtubeIngestFormat.test.js`, which needs
// none of this.
vi.mock('./brain.js', () => ({ createLinkFromUrl: vi.fn() }));
vi.mock('./brainStorage.js', () => ({ getLinkByUrl: vi.fn() }));
vi.mock('./brainJournal.js', () => ({ getSettings: vi.fn(async () => ({ obsidianVaultId: null })) }));
vi.mock('./cosTaskStore.js', () => ({ addTask: vi.fn() }));
vi.mock('./humanActivity.js', () => ({ recordEvents: vi.fn() }));
vi.mock('./videoGen/history.js', () => ({ mutateVideoHistory: vi.fn() }));
vi.mock('./videoGen/events.js', () => ({ videoGenEvents: { emit: vi.fn() } }));
vi.mock('./videoDownload.js', () => ({ buildDownloadHistoryEntry: vi.fn() }));

import {
  YOUTUBE_INGEST_URL_RE,
  assertYoutubeIngestUrl,
  cancelYoutubeIngest,
  __testing,
} from './youtubeIngest.js';

describe('YouTube ingest URL allowlist', () => {
  it('accepts every single-video URL shape', () => {
    for (const url of [
      'https://youtu.be/oCnxnaVg0bY',
      'https://www.youtube.com/watch?v=oCnxnaVg0bY',
      'https://m.youtube.com/watch?v=oCnxnaVg0bY&t=42s',
      'https://music.youtube.com/watch?v=oCnxnaVg0bY',
      'https://youtube.com/shorts/oCnxnaVg0bY',
      'https://www.youtube.com/live/oCnxnaVg0bY',
      'https://www.youtube.com/embed/oCnxnaVg0bY',
    ]) {
      expect(YOUTUBE_INGEST_URL_RE.test(url)).toBe(true);
      expect(() => assertYoutubeIngestUrl(url)).not.toThrow();
    }
  });

  it('rejects playlists, channels, handles, and non-YouTube URLs', () => {
    for (const url of [
      'https://www.youtube.com/playlist?list=PLabcdefghij',
      'https://www.youtube.com/@somechannel',
      'https://www.youtube.com/c/somechannel',
      'https://vimeo.com/123456789',
      'https://x.com/someone/status/123',
      'not a url',
    ]) {
      expect(() => assertYoutubeIngestUrl(url)).toThrow(/single-video YouTube URL/);
    }
  });
});

describe('cancelYoutubeIngest', () => {
  beforeEach(() => __testing.ingestJobs.clear());

  it('returns false for an unknown job', () => {
    expect(cancelYoutubeIngest('nope')).toBe(false);
  });

  it('flags a job with no live child so the between-steps cancel is still honored', () => {
    // An ingest is a chain of steps; cancelling between two of them (or during
    // the non-spawn persist phase) has no process to signal, so the flag — not
    // the kill — is what stops it.
    const job = { id: 'j', clients: [], process: null, canceled: false };
    __testing.ingestJobs.set('j', job);
    expect(cancelYoutubeIngest('j')).toBe(true);
    expect(job.canceled).toBe(true);
  });

  it('signals the running yt-dlp child and escalates if it survives the grace window', () => {
    vi.useFakeTimers();
    const proc = { exitCode: null, signalCode: null, kill: vi.fn() };
    const job = { id: 'j', clients: [], process: proc, canceled: false };
    __testing.ingestJobs.set('j', job);

    expect(cancelYoutubeIngest('j')).toBe(true);
    expect(job.canceled).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(8000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });
});
