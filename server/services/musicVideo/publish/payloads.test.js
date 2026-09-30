/**
 * What each platform posts (#9282): built from the publishing kit and the
 * director's per-platform options, or a 422 naming the missing piece.
 */
import { describe, expect, it } from 'vitest';
import { buildPublishPayload } from './payloads.js';

const kit = (over = {}) => ({
  master: { filename: 'master.mp4' },
  exports: [{ kind: 'x-1080p', filename: 'x.mp4' }, { kind: 'teaser', filename: 'teaser.mp4' }],
  thumbnail: 'thumb-1.jpg',
  captionsFilename: 'captions.srt',
  chapters: [{ startSec: 0, label: 'Intro' }, { startSec: 30, label: 'Chorus' }, { startSec: 75, label: 'Outro' }],
  links: { youtube: 'https://youtu.be/abc', song: 'https://suno.com/song/1234-abcd' },
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
const project = (over = {}, excerpts = [{ status: 'complete', aspect: '9:16', filename: 'cut-a.mp4', startSec: 10, endSec: 30 }]) => ({ publishKit: kit(over), excerpts });

describe('buildPublishPayload (#9282)', () => {
  it('uploads the master to YouTube with chapters appended, thumbnail and captions', () => {
    const p = buildPublishPayload('youtube', project());
    expect(p.video).toEqual({ dir: 'videos', name: 'master.mp4' });
    expect(p.description).toContain('0:00 Intro');
    expect(p.tags).toEqual(['ai music']);
    expect(p.thumbnail).toEqual({ dir: 'videoThumbnails', name: 'thumb-1.jpg' });
    expect(p.captions).toEqual({ dir: 'videos', name: 'captions.srt' });
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
      { status: 'complete', aspect: '9:16', filename: 'old.mp4', startSec: 0, endSec: 20 },
      { status: 'complete', aspect: '16:9', filename: 'wide.mp4', startSec: 0, endSec: 20 },
      { status: 'complete', aspect: '9:16', filename: 'new.mp4', startSec: 40, endSec: 60 },
      { status: 'running', aspect: '9:16', filename: 'partial.mp4' },
    ];
    const shorts = buildPublishPayload('shorts', project({}, excerpts));
    expect(shorts.video.name).toBe('new.mp4');
    expect(shorts.description).toBe('Hook\n\nFull video: https://youtu.be/abc');
    expect(buildPublishPayload('tiktok', project({}, excerpts))).toMatchObject({ video: { name: 'new.mp4' }, coverAtSec: 10 });
    expect(buildPublishPayload('instagram', project({}, excerpts)).caption).toBe('made with portos and suno');
    expect(() => buildPublishPayload('tiktok', project({}, []))).toThrow(/9:16 social cut/);
  });

  it('threads X: hook with the 1080p encode, story, prompt, then links with the full video last', () => {
    const { posts } = buildPublishPayload('x', project(), { prompt: 'the prompt', storyImage: 'still.png' });
    expect(posts.map((p) => p.text)).toEqual(['Watch this', 'How it was made', 'the prompt', 'The song: https://suno.com/song/1234-abcd\nFull video: https://youtu.be/abc']);
    expect(posts[0].media).toEqual({ dir: 'videos', name: 'x.mp4' });
    expect(posts[1].media).toEqual({ dir: 'videoThumbnails', name: 'still.png' });
    expect(() => buildPublishPayload('x', project({ exports: [] }))).toThrow(/1080p/);
  });

  it('prefers the recorded YouTube post over the kit link', () => {
    const p = buildPublishPayload('stackerNews', project({ posts: { youtube: { url: 'https://www.youtube.com/watch?v=posted' } } }));
    expect(p).toMatchObject({ url: 'https://www.youtube.com/watch?v=posted', territory: 'art', title: 'Song' });
  });

  it('validates Reddit subreddits and r/SunoAI\'s genre-bracket title rule', () => {
    expect(buildPublishPayload('reddit', project(), { subreddit: 'r/SunoAI', kind: 'link' })).toMatchObject({ subreddit: 'SunoAI', kind: 'link', url: 'https://youtu.be/abc' });
    expect(buildPublishPayload('reddit', project(), { subreddit: 'aivideo' })).toMatchObject({ kind: 'self', url: '' });
    expect(() => buildPublishPayload('reddit', project(), {})).toThrow(/subreddit/);
    expect(() => buildPublishPayload('reddit', project({ copy: { reddit: { title: 'Song' } } }), { subreddit: 'SunoAI' })).toThrow(/brackets/);
  });

  it('needs a suno.com song URL and captions it with the full video', () => {
    const p = buildPublishPayload('suno', project());
    expect(p).toMatchObject({ songUrl: 'https://suno.com/song/1234-abcd', pin: true, cover: { name: 'thumb-1.jpg' } });
    expect(p.caption).toBe('The story. Music video: https://youtu.be/abc');
    expect(() => buildPublishPayload('suno', project({ links: {} }))).toThrow(/Suno song URL/);
  });

  it('rejects an unknown target', () => {
    expect(() => buildPublishPayload('myspace', project())).toThrow(expect.objectContaining({ status: 400 }));
  });
});
