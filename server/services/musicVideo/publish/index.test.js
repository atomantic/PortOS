/**
 * Posting state machine (#9282) with a fake browser and adapters: prepare
 * fills a draft in a new tab and returns its screenshot. Submit always refuses;
 * manual links persist, and discard/re-prepare close the old tab.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../../lib/mockPathsDataRoot.js';

vi.mock('../../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-publish-'),
}));

const { PATHS } = await import('../../../lib/paths.js');
const projects = await import('../projects.js');
const { preparePublishDraft, discardPublishDraft, listPublishDrafts, recordPublishPost, removePublishPost } = await import('./index.js');
const { musicVideoEvents } = await import('../events.js');
const { stackerNewsAdapter } = await import('./stackerNews.js');

const platforms = { stackerNews: { enabled: true, account: null }, youtube: { enabled: true, account: null }, x: { enabled: true, account: 'antic' } };

afterAll(() => cleanupTempDataRoots());

function fakeBrowser() {
  const pages = [];
  const browsers = [];
  const connect = vi.fn(async () => {
    const browser = { close: vi.fn(async () => {}) };
    browsers.push(browser);
    return {
      browser,
      context: {
        pages: () => pages.filter((page) => !page.closed),
        newPage: async () => {
          const handlers = [];
          const navigated = [];
          const frame = {};
          const page = {
            closed: false, bringToFront: vi.fn(async () => {}), screenshot: vi.fn(async () => Buffer.from('jpg')),
            href: null, text: '',
            url: () => page.href || `https://example.com/post/${pages.indexOf(page)}`,
            once: (_event, fn) => handlers.push(fn),
            on: (event, fn) => { if (event === 'framenavigated') navigated.push(fn); },
            mainFrame: () => frame,
            // The director moves the tab on (by posting, or browsing away).
            navigate: async (href, text = '') => { page.href = href; page.text = text; navigated.forEach((fn) => fn(frame)); await new Promise((r) => setTimeout(r, 0)); },
            waitForFunction: vi.fn(async (_fn, want) => { if (!page.text.includes(want)) throw new Error('timed out'); }),
            isClosed() { return this.closed; },
            close: vi.fn(async function close() { page.closed = true; handlers.forEach((fn) => fn()); }),
          };
          pages.push(page);
          return page;
        },
      },
    };
  });
  return { connect, pages, browsers };
}

const adapter = (over = {}) => ({
  label: 'Stacker News',
  prepare: vi.fn(async (page, payload) => ({ title: payload.title })),
  submit: vi.fn(async () => ({ url: 'https://stacker.news/items/1' })),
  ...over,
});

async function readyProject() {
  const { id } = await projects.createProject({ name: 'Release' });
  await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: {
    links: { youtube: 'https://youtu.be/abc' }, copy: { stackerNews: { title: 'Song', body: 'b' } },
  } } }));
  return id;
}

describe('publish drafts (#9282)', () => {
  it('fills a Substack post on the publication named under Where you post', async () => {
    const { id } = await projects.createProject({ name: 'Release' });
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: {
      links: { youtube: 'https://youtu.be/abc' }, copy: { substack: { title: 'Song', subtitle: 'Sub', body: 'b' } },
    } } }));
    const { connect } = fakeBrowser();
    const substack = adapter({ label: 'Substack' });
    await preparePublishDraft(id, 'substack', {}, { connect, adapters: { substack }, platforms: { substack: { enabled: true, account: 'example' } } });
    expect(substack.prepare).toHaveBeenCalledWith(expect.anything(), { publication: 'example.substack.com', videoUrl: 'https://youtu.be/abc', title: 'Song', subtitle: 'Sub', body: 'b' });
    await expect(preparePublishDraft(id, 'substack', { again: true }, { connect, adapters: { substack }, platforms: { substack: { enabled: true, account: null } } }))
      .rejects.toMatchObject({ status: 422, message: expect.stringMatching(/publication/) });
  });

  it('fills a reviewable draft but never submits it; records a manually published link', async () => {
    const id = await readyProject();
    const { connect, pages } = fakeBrowser();
    const adapters = { stackerNews: adapter() };
    const draft = await preparePublishDraft(id, 'stackerNews', { territory: 'art' }, { connect, adapters, platforms });
    expect(draft).toMatchObject({ target: 'stackerNews', summary: { title: 'Song' } });
    expect(draft.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    expect(adapters.stackerNews.submit).not.toHaveBeenCalled();
    expect(pages[0].closed).toBe(false);
    const { project, post } = await recordPublishPost(id, 'stackerNews', { url: 'https://stacker.news/items/1' });
    expect(post.url).toBe('https://stacker.news/items/1');
    expect(project.publishKit.posts.stackerNews.url).toBe(post.url);
  });

  it('records the post the director makes by hand in the filled tab, and nothing else they browse to', async () => {
    const id = await readyProject();
    const { connect, pages } = fakeBrowser();
    const events = [];
    const onEvent = (e) => events.push(e);
    musicVideoEvents.on('publish-draft', onEvent);
    try {
      const adapters = { stackerNews: adapter({ findPost: stackerNewsAdapter.findPost }) };
      const draft = await preparePublishDraft(id, 'stackerNews', { territory: 'art' }, { connect, adapters, platforms });
      // Another item's page, or a page without this post's title, is not this post.
      await pages[0].navigate('https://stacker.news/~art', 'Song');
      await pages[0].navigate('https://stacker.news/items/99', 'Someone else\'s post');
      expect((await projects.getProject(id)).publishKit.posts?.stackerNews).toBeUndefined();

      await pages[0].navigate('https://stacker.news/items/123', 'Song \\ stacker news');
      await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ draftId: draft.draftId, state: 'posted', url: 'https://stacker.news/items/123' }));
      expect(events.at(-1).project.publishKit.posts.stackerNews.url).toBe('https://stacker.news/items/123');
      expect((await projects.getProject(id)).publishKit.posts.stackerNews).toMatchObject({ url: 'https://stacker.news/items/123', postedAt: expect.any(String) });
      expect(adapters.stackerNews.submit).not.toHaveBeenCalled();
      expect(pages[0].closed).toBe(false); // the tab now shows their post
      expect(await listPublishDrafts(id, { connect })).toEqual([]);
    } finally {
      musicVideoEvents.off('publish-draft', onEvent);
    }
  });

  it('closes the earlier draft when the same target is filled again, and discards on request', async () => {
    const id = await readyProject();
    const { connect, pages } = fakeBrowser();
    const adapters = { stackerNews: adapter() };
    const _first = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters, platforms });
    const second = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters, platforms });
    expect(pages[0].closed).toBe(true);
    expect(await discardPublishDraft(id, second.draftId)).toBe(true);
    expect(pages[1].closed).toBe(true);
    expect(await discardPublishDraft(id, second.draftId)).toBe(false);
  });

  it('keeps the filled tab open past the TTL, lists it for a reloaded card, and reports a hand-closed tab', async () => {
    vi.useFakeTimers();
    try {
      const id = await readyProject();
      const { connect, pages, browsers } = fakeBrowser();
      const events = [];
      const onEvent = (e) => events.push(e);
      musicVideoEvents.on('publish-draft', onEvent);
      const draft = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters: { stackerNews: adapter() }, platforms });
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      expect(pages[0].closed).toBe(false);
      expect(browsers[0].close).toHaveBeenCalled(); // CDP session dropped

      expect(await listPublishDrafts(id, { connect })).toMatchObject([{ draftId: draft.draftId, state: 'open', summary: { title: 'Song' } }]);
      expect(await listPublishDrafts('other-project', { connect })).toEqual([]);

      pages[0].closed = true; // the human closed the tab
      expect(await listPublishDrafts(id, { connect })).toMatchObject([{ draftId: draft.draftId, state: 'closed' }]);
      expect(events.at(-1)).toMatchObject({ draftId: draft.draftId, state: 'closed' });
      expect(await discardPublishDraft(id, draft.draftId, { connect })).toBe(true);
      expect(events.at(-1)).toMatchObject({ state: 'discarded' });
      musicVideoEvents.off('publish-draft', onEvent);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards a detached draft by closing its still-open tab', async () => {
    vi.useFakeTimers();
    try {
      const id = await readyProject();
      const { connect, pages } = fakeBrowser();
      const draft = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters: { stackerNews: adapter() }, platforms });
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      expect(await discardPublishDraft(id, draft.draftId, { connect })).toBe(true);
      expect(pages[0].closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the tab and surfaces the adapter\'s error when a fill fails', async () => {
    const id = await readyProject();
    const { connect, pages } = fakeBrowser();
    const err = Object.assign(new Error('Sign in'), { status: 409, code: 'PUBLISH_LOGIN_REQUIRED' });
    const adapters = { stackerNews: adapter({ prepare: vi.fn(async () => { throw err; }) }) };
    await expect(preparePublishDraft(id, 'stackerNews', {}, { connect, adapters, platforms })).rejects.toBe(err);
    expect(pages[0].closed).toBe(true);
  });

  it('refuses a platform the director has not turned on, before opening a tab', async () => {
    const id = await readyProject();
    const { connect } = fakeBrowser();
    await expect(preparePublishDraft(id, 'stackerNews', {}, { connect, adapters: { stackerNews: adapter() }, platforms: { stackerNews: { enabled: false } } }))
      .rejects.toMatchObject({ status: 409, code: 'PUBLISH_PLATFORM_DISABLED' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('closes a draft filled while signed in to the wrong account', async () => {
    const id = await readyProject();
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { ...current.publishKit, exports: [{ kind: 'x-1080p', filename: 'x.mp4' }], copy: { x: { hook: 'hi' } } } } }));
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'x.mp4'), 'x');
    const { connect, pages } = fakeBrowser();
    const adapters = { x: adapter({ label: 'X', prepare: vi.fn(async () => ({ account: 'someone_else' })) }) };
    await expect(preparePublishDraft(id, 'x', {}, { connect, adapters, platforms })).rejects.toMatchObject({ status: 409, code: 'PUBLISH_WRONG_ACCOUNT' });
    expect(pages[0].closed).toBe(true);
    adapters.x.prepare = vi.fn(async () => ({ account: 'Antic' }));
    await expect(preparePublishDraft(id, 'x', {}, { connect, adapters, platforms })).resolves.toMatchObject({ target: 'x' });
  });

  it('records a post made by hand, then its reception and notes', async () => {
    const id = await readyProject();
    const first = await recordPublishPost(id, 'reddit', { url: 'https://www.reddit.com/r/x/comments/1' });
    expect(first.post).toMatchObject({ url: 'https://www.reddit.com/r/x/comments/1' });
    expect(first.post.postedAt).toBeTruthy();
    const rated = await recordPublishPost(id, 'reddit', { reception: 'poor', notes: 'poorly received' });
    expect(rated.post).toMatchObject({ url: 'https://www.reddit.com/r/x/comments/1', reception: 'poor', notes: 'poorly received', postedAt: first.post.postedAt });
    expect(rated.project.publishKit.posts.reddit.reception).toBe('poor');
  });

  it('marks a platform done without a link, keeps a link added later, and undoes the mark', async () => {
    const id = await readyProject();
    const marked = await recordPublishPost(id, 'distrokid', { posted: true });
    expect(marked.post.url).toBeUndefined();
    expect(marked.post.postedAt).toBeTruthy();
    const linked = await recordPublishPost(id, 'distrokid', { url: 'https://open.spotify.com/track/example' });
    expect(linked.post).toMatchObject({ url: 'https://open.spotify.com/track/example', postedAt: marked.post.postedAt });
    const { project } = await removePublishPost(id, 'distrokid');
    expect(project.publishKit.posts.distrokid).toBeUndefined();
    // undoing a platform with no record is a no-op
    await expect(removePublishPost(id, 'distrokid')).resolves.toMatchObject({ project: { id } });
  });

  it('resolves release files to paths, and 422s before opening a tab when one is missing', async () => {
    const id = await readyProject();
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { ...current.publishKit, master: { filename: 'master.mp4' }, copy: { youtube: { title: 'Song' } } } } }));
    const { connect } = fakeBrowser();
    const adapters = { youtube: adapter({ label: 'YouTube' }) };
    await expect(preparePublishDraft(id, 'youtube', {}, { connect, adapters, platforms })).rejects.toMatchObject({ status: 422, code: 'PUBLISH_ASSET_MISSING' });
    expect(connect).not.toHaveBeenCalled();

    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'master.mp4'), 'x');
    await preparePublishDraft(id, 'youtube', {}, { connect, adapters, platforms });
    expect(adapters.youtube.prepare.mock.calls[0][1].video.path).toBe(join(PATHS.videos, 'master.mp4'));

    // Once posted, a second draft (a duplicate post) needs the director's explicit "again".
    await recordPublishPost(id, 'youtube', { url: 'https://www.youtube.com/watch?v=example' });
    connect.mockClear();
    await expect(preparePublishDraft(id, 'youtube', {}, { connect, adapters, platforms })).rejects.toMatchObject({ status: 409, code: 'PUBLISH_ALREADY_POSTED', context: { target: 'youtube', urls: ['https://www.youtube.com/watch?v=example'] } });
    expect(connect).not.toHaveBeenCalled();
    await preparePublishDraft(id, 'youtube', { again: true }, { connect, adapters, platforms });
    expect(adapters.youtube.prepare).toHaveBeenCalledTimes(2);
  });

  it('sends the song to DistroKid with its audio, a square store cover, and the account as the artist', async () => {
    const id = await readyProject();
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, uploadedAudioFilename: 'song.wav', publishKit: { ...current.publishKit, thumbnail: 'thumb.jpg' } } }));
    await mkdir(PATHS.videoThumbnails, { recursive: true });
    await writeFile(join(PATHS.videoThumbnails, 'thumb.jpg'), 'x');
    const audio = join(PATHS.videoThumbnails, 'thumb.jpg'); // any file on disk stands in for the song
    const dk = { distrokid: { enabled: true, account: 'Example Artist' } };
    const { connect } = fakeBrowser();
    const adapters = { distrokid: adapter({ label: 'DistroKid' }) };
    const options = { songwriterFirst: 'Alice', songwriterLast: 'Example' };
    const resolveAudio = vi.fn(async () => audio);

    // Without ffmpeg the 16:9 frame would be uploaded as the cover; the store rejects it, so no tab opens.
    await expect(preparePublishDraft(id, 'distrokid', options, { connect, adapters, platforms: dk, resolveAudio, findFfmpeg: async () => null }))
      .rejects.toMatchObject({ status: 422, code: 'PUBLISH_ASSET_MISSING' });
    expect(connect).not.toHaveBeenCalled();

    const runFfmpegProcess = vi.fn(async () => ({ ok: true }));
    await preparePublishDraft(id, 'distrokid', options, { connect, adapters, platforms: dk, resolveAudio, findFfmpeg: async () => 'ffmpeg', runFfmpegProcess });
    const payload = adapters.distrokid.prepare.mock.calls[0][1];
    expect(payload).toMatchObject({ title: 'Release', artist: 'Example Artist', songwriter: { first: 'Alice', last: 'Example' }, audio: { path: audio }, instrumental: true });
    expect(payload.cover.name).toMatch(/^publish-cover-distrokid-/);
    expect(runFfmpegProcess.mock.calls[0][0].args.join(' ')).toContain('scale=3000:3000');
    expect(resolveAudio.mock.calls[0][0]).toMatchObject({ id, uploadedAudioFilename: 'song.wav' });

    // Composed cover art is already store size: it goes up as is, with no ffmpeg cut.
    await writeFile(join(PATHS.videoThumbnails, 'cover-example.jpg'), 'x');
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { ...current.publishKit, coverArt: { filename: 'cover-example.jpg' } } } }));
    runFfmpegProcess.mockClear();
    await preparePublishDraft(id, 'distrokid', options, { connect, adapters, platforms: dk, resolveAudio, findFfmpeg: async () => null, runFfmpegProcess });
    expect(adapters.distrokid.prepare.mock.calls.at(-1)[1].cover).toMatchObject({ name: 'cover-example.jpg', path: join(PATHS.videoThumbnails, 'cover-example.jpg') });
    expect(runFfmpegProcess).not.toHaveBeenCalled();
  });

  it('refuses a DistroKid draft whose song is unset or gone, in publishing terms, before opening a tab', async () => {
    const id = await readyProject();
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { ...current.publishKit, thumbnail: 'thumb.jpg' } } }));
    await mkdir(PATHS.videoThumbnails, { recursive: true });
    await writeFile(join(PATHS.videoThumbnails, 'thumb.jpg'), 'x');
    const { connect } = fakeBrowser();
    const deps = { connect, adapters: { distrokid: adapter({ label: 'DistroKid' }) }, platforms: { distrokid: { enabled: true, account: 'Example Artist' } } };
    const options = { songwriterFirst: 'Alice', songwriterLast: 'Example' };
    await expect(preparePublishDraft(id, 'distrokid', options, deps)).rejects.toMatchObject({ status: 422, code: 'PUBLISH_ASSET_MISSING', message: expect.stringMatching(/Set the project's song/) });
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, uploadedAudioFilename: 'gone.wav' } }));
    await expect(preparePublishDraft(id, 'distrokid', options, deps)).rejects.toMatchObject({ status: 422, code: 'PUBLISH_ASSET_MISSING', message: expect.stringMatching(/missing on disk/) });
    expect(connect).not.toHaveBeenCalled();
  });
});
