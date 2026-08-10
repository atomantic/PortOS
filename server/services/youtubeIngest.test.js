import { describe, it, expect, vi, beforeEach } from 'vitest';

// The ingest module pulls in the brain/cos/media graphs at import time for its
// spawn path; the pure helpers under test need none of it. Stub the heavy edges
// so this suite exercises the parsing/rendering contracts without a live store.
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
  parseVideoMetadata,
  buildIngestNote,
  buildAgentTaskContext,
  cancelYoutubeIngest,
  resolveObsidianPointer,
  __testing,
} from './youtubeIngest.js';

const META = {
  videoId: 'oCnxnaVg0bY',
  title: 'A talk about "writing tools"',
  channel: 'Example Channel',
  durationSec: 3723,
  publishedAt: '2026-01-15',
  description: 'Some description.',
};

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

describe('parseVideoMetadata', () => {
  it('normalizes the fields the ingest stores', () => {
    const meta = parseVideoMetadata(JSON.stringify({
      id: 'oCnxnaVg0bY',
      title: '  Some Talk  ',
      channel: 'Example Channel',
      channel_url: 'https://youtube.com/@example',
      duration: 3723.4,
      upload_date: '20260115',
      description: ' body ',
      thumbnail: 'https://i.ytimg.com/x.jpg',
      subtitles: { en: [{ ext: 'vtt' }] },
    }));
    expect(meta).toEqual({
      videoId: 'oCnxnaVg0bY',
      title: 'Some Talk',
      channel: 'Example Channel',
      channelUrl: 'https://youtube.com/@example',
      durationSec: 3723,
      publishedAt: '2026-01-15',
      description: 'body',
      thumbnailUrl: 'https://i.ytimg.com/x.jpg',
      hasManualCaptions: true,
    });
  });

  it('reads manual-vs-auto captions from `subtitles`, not `automatic_captions`', () => {
    // The real shape for an auto-captioned upload (verified against
    // youtu.be/oCnxnaVg0bY): `subtitles` empty, `automatic_captions` populated.
    // Filenames can't distinguish the two — yt-dlp writes both as `<base>.en.vtt`.
    expect(parseVideoMetadata({ subtitles: {}, automatic_captions: { en: [{}], fr: [{}] } }).hasManualCaptions).toBe(false);
    expect(parseVideoMetadata({}).hasManualCaptions).toBe(false);
  });

  it('falls back to uploader fields and tolerates missing/odd values', () => {
    const meta = parseVideoMetadata({ uploader: 'Someone', uploader_url: 'u', duration: 0, upload_date: 'nope' });
    expect(meta.channel).toBe('Someone');
    expect(meta.channelUrl).toBe('u');
    // A zero/absent duration must be null, not 0 — `0` would render a bogus
    // "0:00" duration in the note frontmatter.
    expect(meta.durationSec).toBeNull();
    expect(meta.publishedAt).toBeNull();
    expect(meta.title).toBe('Untitled video');
  });
});

describe('buildIngestNote', () => {
  const note = buildIngestNote({
    meta: META,
    url: 'https://youtu.be/oCnxnaVg0bY',
    transcript: { text: 'Hello world.', language: 'en', source: 'captions' },
    tags: ['writing-tools'],
    agentPrompt: 'Review for feature ideas.',
    capturedAt: '2026-08-05T12:00:00.000Z',
  });

  it('emits parseable frontmatter with the source, duration, and tags', () => {
    expect(note.startsWith('---\n')).toBe(true);
    // Quotes inside a title must be escaped or the YAML block breaks.
    expect(note).toContain('title: "A talk about \\"writing tools\\""');
    expect(note).toContain('source: https://youtu.be/oCnxnaVg0bY');
    expect(note).toContain('duration: "1:02:03"');
    expect(note).toContain('published: 2026-01-15');
    expect(note).toContain('captured: 2026-08-05');
    expect(note).toContain(`tags: ["youtube", "consumed", "portos", "writing-tools"]`);
  });

  it('carries the transcript, description, and the "why I kept this" callout', () => {
    expect(note).toContain('## Transcript\n\nHello world.');
    expect(note).toContain('## Description');
    expect(note).toContain('> Review for feature ideas.');
  });

  it('says so explicitly when there were no captions', () => {
    const bare = buildIngestNote({
      meta: { ...META, description: '' },
      url: 'https://youtu.be/oCnxnaVg0bY',
      transcript: null,
      tags: [],
      agentPrompt: '',
      capturedAt: '2026-08-05T12:00:00.000Z',
    });
    expect(bare).toContain('_No captions were available for this video._');
    expect(bare).not.toContain('## Description');
    expect(bare).not.toContain('Why I kept this');
  });
});

describe('buildAgentTaskContext', () => {
  it('leads with the user request and points the agent at the transcript', () => {
    const context = buildAgentTaskContext({
      meta: META,
      url: 'https://youtu.be/oCnxnaVg0bY',
      agentPrompt: 'Review for writing-tool improvements.',
      transcriptPath: '/data/brain/youtube/oCnxnaVg0bY.md',
      notePath: 'Consumed/YouTube/note.md',
      tags: ['writing-tools'],
      hasTranscript: true,
    });
    expect(context).toContain('Review for writing-tool improvements.');
    expect(context).toContain('/data/brain/youtube/oCnxnaVg0bY.md');
    expect(context).toContain('Consumed/YouTube/note.md');
    expect(context).toContain('portos-file-issue');
    expect(context).toContain('**Duration:** 1:02:03');
  });

  it('tells the agent when no transcript exists rather than pointing at a missing file', () => {
    const context = buildAgentTaskContext({
      meta: META,
      url: 'https://youtu.be/oCnxnaVg0bY',
      agentPrompt: 'Do a thing.',
      transcriptPath: null,
      notePath: null,
      tags: [],
      hasTranscript: false,
    });
    expect(context).toContain('not available');
    expect(context).not.toContain('read this first');
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

describe('buildIngestNote frontmatter safety', () => {
  // The note advertises parseable YAML frontmatter, and a tag is free user text.
  // Bare in a flow sequence, each of these breaks the block: `#` comments out the
  // rest of the line, `: ` turns the entry into a mapping, `]` closes the
  // sequence early, and `"` unbalances the scalar.
  it.each([
    ['#research', 'a leading hash'],
    ['topic: notes', 'a colon-space'],
    ['bad]tag', 'a closing bracket'],
    ['say "hi"', 'embedded quotes'],
    ['back\\slash', 'a backslash'],
  ])('quotes a tag containing %j (%s)', (tag) => {
    const note = buildIngestNote({
      meta: META,
      url: 'https://youtu.be/oCnxnaVg0bY',
      transcript: { text: 'x', language: 'en', source: 'captions' },
      tags: [tag],
      agentPrompt: '',
      capturedAt: '2026-08-05T12:00:00.000Z',
    });
    const tagsLine = note.split('\n').find((l) => l.startsWith('tags: '));
    // The escaped form of the tag appears, and nothing outside quotes can break out.
    const escaped = tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    expect(tagsLine).toContain(`"${escaped}"`);
    // Every value on the line is a quoted scalar — no bare tokens survived.
    const inner = tagsLine.slice('tags: ['.length, -1);
    for (const part of inner.split('", "')) {
      expect(part.startsWith('"') || part.endsWith('"') || inner.startsWith('"')).toBe(true);
    }
  });

  it('quotes a title containing a colon so the frontmatter stays one mapping', () => {
    const note = buildIngestNote({
      meta: { ...META, title: 'Storytelling: the eight principles' },
      url: 'https://youtu.be/oCnxnaVg0bY',
      transcript: null,
      tags: [],
      agentPrompt: '',
      capturedAt: '2026-08-05T12:00:00.000Z',
    });
    expect(note).toContain('title: "Storytelling: the eight principles"');
  });
});

/**
 * The index records ONE note location per video, and putIngest MERGES — so an
 * explicit `obsidian: null` erases the prior pointer and strands the note where
 * deleteIngest can never unlink it. #3706 made that reachable on a healthy vault
 * by giving updateNote a transient failure (an iCloud-evicted note is refused,
 * which upsertNote reports as the same null a hard failure gives).
 */
describe('resolveObsidianPointer', () => {
  const prior = { obsidian: { path: 'Consumed/YouTube/2026-01-15 talk.md', vaultId: 'v1' } };

  it('records the new location when the mirror succeeded', () => {
    expect(resolveObsidianPointer({
      written: 'Consumed/YouTube/2026-03-01 talk.md', vaultId: 'v1', notePath: 'x.md', prior,
    })).toEqual({ path: 'Consumed/YouTube/2026-03-01 talk.md', vaultId: 'v1' });
  });

  it('KEEPS the prior pointer when an attempted mirror failed', () => {
    // The evicted-note case: without this the existing note is orphaned and the
    // next re-ingest mints a second note at a fresh dated path.
    expect(resolveObsidianPointer({
      written: null, vaultId: 'v1', notePath: 'Consumed/YouTube/2026-01-15 talk.md', prior,
    })).toEqual(prior.obsidian);
  });

  it('nulls out when NO mirror was attempted (no vault configured)', () => {
    // notePath null means we never tried — an explicit null is the honest record,
    // not a failure being papered over.
    expect(resolveObsidianPointer({ written: null, vaultId: null, notePath: null, prior })).toBeNull();
  });

  it('nulls out when an attempt failed and there is no prior pointer to keep', () => {
    expect(resolveObsidianPointer({
      written: null, vaultId: 'v1', notePath: 'x.md', prior: null,
    })).toBeNull();
  });
});
