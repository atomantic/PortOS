/**
 * What each platform posts (#9282): built from the publishing kit and the
 * director's per-platform options, or a 422 naming the missing piece.
 */
import { describe, expect, it } from 'vitest';
import { buildPublishPayload, substackPublication } from './payloads.js';
import { captureMusicVideoEvidence } from '../../../lib/musicVideoDependencies.js';

const kit = (over = {}) => ({
  master: { filename: 'master.mp4' },
  exports: [{ kind: 'x-1080p', filename: 'x.mp4' }, { kind: 'teaser', filename: 'teaser.mp4' }],
  thumbnail: 'thumb-1.jpg',
  captionsFilename: 'captions.srt',
  chapters: [{ startSec: 0, label: 'Intro' }, { startSec: 30, label: 'Chorus' }, { startSec: 75, label: 'Outro' }],
  links: { youtube: 'https://youtu.be/abc', song: 'https://suno.com/song/12345678-abcd-4abc-8abc-123456789abc' },
  copy: {
    youtube: { title: 'Song — Music Video', description: 'The story.\n\nMore.', tags: ['ai music', ' '] },
    shorts: { title: 'Song #Shorts', description: 'Hook' },
    x: { hook: 'Watch this', story: 'How it was made' },
    tiktok: { caption: 'tt caption' },
    instagram: { caption: 'made with @portos and @suno' },
    reddit: { title: '[Electropop] Song', body: 'Body' },
    stackerNews: { title: 'Song', body: 'SN body' },
  },
  ...over,
});
const evidence = () => captureMusicVideoEvidence({ scenes: [] }, { startSec: 0, endSec: 20 });
const project = (over = {}, excerpts = [{ status: 'complete', aspect: '9:16', filename: 'cut-a.mp4', startSec: 10, endSec: 30, dependencies: evidence() }]) => ({ scenes: [], publishKit: kit(over), excerpts });

describe('buildPublishPayload (#9282)', () => {
  it('uploads the master to YouTube with chapters appended, thumbnail and captions', () => {
    const p = buildPublishPayload('youtube', project());
    expect(p.video).toEqual({ dir: 'videos', name: 'master.mp4' });
    expect(p.description).toContain('0:00 Intro');
    expect(p.tags).toEqual(['ai music']);
    expect(p.thumbnail).toEqual({ dir: 'videoThumbnails', name: 'thumb-1.jpg' });
    expect(p.captions).toEqual({ dir: 'videos', name: 'captions.srt' });
  });

  it('refuses YouTube, X and Reddit video drafts when the kit master is from an earlier render (#10146)', () => {
    const staleProject = () => ({ ...project({ master: { filename: 'master.mp4', renderHistoryId: 'old' } }), renderHistoryId: 'new' });
    for (const platform of ['youtube', 'x', 'reddit']) {
      expect(() => buildPublishPayload(platform, staleProject())).toThrow(expect.objectContaining({ status: 409, code: 'PUBLISH_KIT_STALE' }));
    }
    const fresh = { ...project({ master: { filename: 'master.mp4', renderHistoryId: 'new' } }), renderHistoryId: 'new' };
    expect(buildPublishPayload('youtube', fresh).video.name).toBe('master.mp4');
  });

  it('does not repeat chapters the description already has', () => {
    const p = buildPublishPayload('youtube', project({ copy: { youtube: { title: 't', description: 'x\n0:00 Start\n0:30 Next' } } }));
    expect(p.description).not.toContain('Chapters');
  });

  it('refuses YouTube without a built kit or a title, and a title over the limit', () => {
    expect(() => buildPublishPayload('youtube', { publishKit: {} })).toThrow(expect.objectContaining({ status: 422, code: 'PUBLISH_ASSET_MISSING' }));
    expect(() => buildPublishPayload('youtube', project({ copy: {} }))).toThrow(/title/);
    expect(() => buildPublishPayload('youtube', project({ copy: { youtube: { title: 'x'.repeat(101) } } }))).toThrow(/limit is 100/);
  });

  it('sends the newest 9:16 cut to Shorts, TikTok and Reels, linking the full video from Shorts', () => {
    const excerpts = [
      { status: 'complete', aspect: '9:16', filename: 'old.mp4', startSec: 0, endSec: 20, dependencies: evidence() },
      { status: 'complete', aspect: '16:9', filename: 'wide.mp4', startSec: 0, endSec: 20, dependencies: evidence() },
      { status: 'complete', aspect: '9:16', filename: 'new.mp4', startSec: 40, endSec: 60, dependencies: evidence() },
      { status: 'running', aspect: '9:16', filename: 'partial.mp4' },
    ];
    const shorts = buildPublishPayload('shorts', project({}, excerpts));
    expect(shorts.video.name).toBe('new.mp4');
    expect(shorts.description).toBe('Hook\n\nFull video: https://youtu.be/abc');
    expect(buildPublishPayload('tiktok', project({}, excerpts))).toMatchObject({ video: { name: 'new.mp4' }, coverAtSec: 10 });
    expect(buildPublishPayload('instagram', project({}, excerpts)).caption).toBe('made with portos and suno');
    expect(() => buildPublishPayload('tiktok', project({}, []))).toThrow(/9:16 social cut/);
  });

  it('uses the kit fit-with-fill vertical encode for a 16:9 render with no social cut, and only while the kit is fresh (#10150)', () => {
    const exports = [{ kind: 'vertical-9x16', filename: 'vertical.mp4', startSec: 5, endSec: 35 }];
    const wide = { ...project({ exports, master: { filename: 'master.mp4', renderHistoryId: 'r1' } }, []), renderHistoryId: 'r1' };
    expect(buildPublishPayload('shorts', wide).video.name).toBe('vertical.mp4');
    expect(buildPublishPayload('tiktok', wide)).toMatchObject({ video: { name: 'vertical.mp4' }, coverAtSec: 15 });
    expect(() => buildPublishPayload('instagram', { ...wide, renderHistoryId: 'r2' })).toThrow(/9:16 social cut/);
  });

  it('lets the director pick a cut and refuses stale ones (#10150)', () => {
    const stale = { id: 'mve-stale', status: 'complete', aspect: '9:16', filename: 'stale.mp4', startSec: 0, endSec: 10, dependencies: { ...evidence(), references: [{ role: 'song', assetId: 'x', revision: 'old' }] } };
    const fresh = { id: 'mve-fresh', status: 'complete', aspect: '9:16', filename: 'fresh.mp4', startSec: 0, endSec: 10, dependencies: evidence() };
    expect(buildPublishPayload('shorts', project({}, [fresh, stale])).video.name).toBe('fresh.mp4');
    expect(buildPublishPayload('shorts', project({}, [fresh, stale]), { cutId: 'mve-fresh' }).video.name).toBe('fresh.mp4');
    expect(() => buildPublishPayload('shorts', project({}, [fresh, stale]), { cutId: 'mve-stale' })).toThrow(expect.objectContaining({ status: 409, code: 'PUBLISH_CUT_STALE' }));
    expect(() => buildPublishPayload('tiktok', project({}, [stale]))).toThrow(expect.objectContaining({ code: 'PUBLISH_CUT_STALE' }));
  });

  it('threads X: hook with the 1080p encode, story, prompt, then links with the full video last', () => {
    const { posts } = buildPublishPayload('x', project(), { prompt: 'the prompt', storyImage: 'still.png' });
    expect(posts.map((p) => p.text)).toEqual(['Watch this', 'How it was made', 'the prompt', 'The song: https://suno.com/song/12345678-abcd-4abc-8abc-123456789abc\nFull video: https://youtu.be/abc']);
    expect(posts[0].media).toEqual({ dir: 'videos', name: 'x.mp4' });
    expect(posts[1].media).toEqual({ dir: 'videoThumbnails', name: 'still.png' });
    expect(() => buildPublishPayload('x', project({ exports: [] }))).toThrow(/1080p/);
  });

  it('prefers the recorded YouTube post over the kit link', () => {
    const p = buildPublishPayload('stackerNews', project({ posts: { youtube: { url: 'https://www.youtube.com/watch?v=posted' } } }));
    expect(p).toMatchObject({ url: 'https://www.youtube.com/watch?v=posted', territory: 'art', title: 'Song' });
  });

  it('reads the Substack publication from a name, a pasted URL or a custom domain', () => {
    expect(substackPublication('example')).toBe('example.substack.com');
    expect(substackPublication('https://Example.substack.com/p/old-post')).toBe('example.substack.com');
    expect(substackPublication('news.example.com')).toBe('news.example.com');
    expect(substackPublication('not a host')).toBeNull();
    const copy = { substack: { title: 'Song', subtitle: '', body: 'Body' } };
    expect(buildPublishPayload('substack', project({ copy }), { publication: 'example' }))
      .toEqual({ publication: 'example.substack.com', videoUrl: 'https://youtu.be/abc', title: 'Song', subtitle: '', body: 'Body' });
    expect(() => buildPublishPayload('substack', project({ copy, links: {} }), { publication: 'example' })).toThrow(/publish to YouTube first/);
    expect(() => buildPublishPayload('substack', project(), { publication: 'example' })).toThrow(/substack title/);
  });

  it('posts a native video to r/aivideo by default, and validates other subreddits\' rules', () => {
    const named = (over = {}) => ({ ...project({ copy: { reddit: { title: 'Song Name — a music video', body: 'Body' } }, ...over }), name: 'Song Name' });
    expect(buildPublishPayload('reddit', named(), {})).toMatchObject({ subreddit: 'aivideo', kind: 'video', video: { dir: 'videos', name: 'master.mp4' }, body: '' });
    expect(() => buildPublishPayload('reddit', { ...named(), name: 'Other Title' }, {})).toThrow(/include the video's name/);
    expect(() => buildPublishPayload('reddit', named({ master: null }), {})).toThrow(/final render/);
    expect(buildPublishPayload('reddit', project(), { subreddit: 'r/SunoAI', kind: 'link' })).toMatchObject({ subreddit: 'SunoAI', kind: 'link', url: 'https://youtu.be/abc' });
    expect(buildPublishPayload('reddit', project(), { subreddit: 'aimusic', kind: 'self' })).toMatchObject({ kind: 'self', url: '', video: null, body: 'Body' });
    expect(() => buildPublishPayload('reddit', project(), { subreddit: 'x' })).toThrow(/subreddit/);
    expect(() => buildPublishPayload('reddit', project({ copy: { reddit: { title: 'Song' } } }), { subreddit: 'SunoAI', kind: 'self' })).toThrow(/brackets/);
  });

  it('needs a suno.com song URL and captions it with the full video', () => {
    const p = buildPublishPayload('suno', project());
    expect(p).toMatchObject({ songUrl: 'https://suno.com/song/12345678-abcd-4abc-8abc-123456789abc', pin: true, cover: { name: 'thumb-1.jpg' } });
    expect(p.caption).toBe('The story. Music video: https://youtu.be/abc');
    expect(() => buildPublishPayload('suno', project({ links: {} }))).toThrow(/Suno song URL/);
    // The adapter needs the song's id to find its menu, so an id-less song URL is refused up front.
    expect(() => buildPublishPayload('suno', project({ links: {} }), { songUrl: 'https://suno.com/song/example' })).toThrow(/Suno song URL/);
  });

  it('rejects an unknown target', () => {
    expect(() => buildPublishPayload('myspace', project())).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('names what DistroKid still needs, and defaults the store flags from the song', () => {
    const song = (over = {}) => ({ ...project(), name: 'Song', lyricCues: [{ text: 'a line', startSec: 0, endSec: 1 }], ...over });
    const who = { artistName: 'Example Artist', songwriterFirst: 'Alice', songwriterLast: 'Example' };
    expect(() => buildPublishPayload('distrokid', song(), { ...who, artistName: '' })).toThrow(/artist name/);
    expect(() => buildPublishPayload('distrokid', song(), { ...who, songwriterLast: '' })).toThrow(/songwriter/);
    expect(() => buildPublishPayload('distrokid', { ...song(), publishKit: kit({ thumbnail: null }) }, who)).toThrow(/cover art/);
    expect(buildPublishPayload('distrokid', song(), who)).toMatchObject({
      title: 'Song', artist: 'Example Artist', explicit: false, instrumental: false, releaseDate: null,
      ai: { lyrics: false, music: true, vocals: true }, cover: { name: 'thumb-1.jpg' },
      songwriterRole: 'both', language: 'English', genre: null, secondaryGenre: null, newArtistProfile: false, preserveCaps: false,
      credits: { performer: 'Alice Example', producer: 'Alice Example', performerRole: null }, previewStartSec: null,
    });
    // Genre comes from the song's own style words; the director's picks win, and the preview opens on the hook.
    const styled = song({ autonomousRun: { output: { sunoStyle: 'dark synthwave, pop hooks, female vocal' } } });
    expect(buildPublishPayload('distrokid', styled, who)).toMatchObject({ genre: 'Electronic', secondaryGenre: 'Pop' });
    expect(buildPublishPayload('distrokid', styled, { ...who, genre: 'Pop', secondaryGenre: 'Pop', newArtistProfile: true, performerName: 'Bob Example', performerRole: 'Vocals', previewStartSec: 42.7 }))
      .toMatchObject({ genre: 'Pop', secondaryGenre: null, newArtistProfile: true, credits: { performer: 'Bob Example', performerRole: 'Vocals', producer: 'Alice Example' }, previewStartSec: 42 });
    // An all-lowercase artist name keeps its capitalization on the stores.
    expect(buildPublishPayload('distrokid', song(), { ...who, artistName: 'example' }).preserveCaps).toBe(true);
    expect(buildPublishPayload('distrokid', song({ lyricCues: [] }), { ...who, aiLyrics: true, releaseDate: '2026-11-06' }))
      .toMatchObject({ instrumental: true, releaseDate: '2026-11-06', ai: { lyrics: true } });
    // The composed cover art wins over the thumbnail, for DistroKid and Suno alike.
    const withCover = song({ publishKit: kit({ coverArt: { filename: 'cover-1.jpg' } }) });
    expect(buildPublishPayload('distrokid', withCover, who).cover).toEqual({ dir: 'videoThumbnails', name: 'cover-1.jpg', square: true });
    expect(buildPublishPayload('distrokid', { ...withCover, publishKit: kit({ thumbnail: null, coverArt: { filename: 'cover-1.jpg' } }) }, who).cover.name).toBe('cover-1.jpg');
    expect(buildPublishPayload('suno', withCover, { songUrl: 'https://suno.com/song/87654321-dcba-4cba-8cba-cba987654321' }).cover.name).toBe('cover-1.jpg');
  });
});
