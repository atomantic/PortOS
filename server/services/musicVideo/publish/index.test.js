/**
 * Posting state machine (#9282) with a fake browser and adapters: prepare
 * fills a draft in a new tab and returns its screenshot. Submit always refuses;
 * manual links persist, and discard/re-prepare close the old tab.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../../lib/mockPathsDataRoot.js';

vi.mock('../../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-publish-'),
}));

const { PATHS } = await import('../../../lib/paths.js');
const projects = await import('../projects.js');
const { preparePublishDraft, previewPublishPost, discardPublishDraft, listPublishDrafts, recordPublishPost, removePublishPost, prepareCrossLinkEdit, setPublishCrossLinks } = await import('./index.js');
const { musicVideoEvents } = await import('../events.js');
const { stackerNewsAdapter } = await import('./stackerNews.js');
const { step } = await import('./browser.js');

const platforms = { stackerNews: { enabled: true, account: null }, youtube: { enabled: true, account: null }, x: { enabled: true, account: 'antic' } };

afterAll(() => cleanupTempDataRoots());

function fakeBrowser({ pageError } = {}) {
  const pages = [];
  const browsers = [];
  const newCDPSession = vi.fn(async (page) => ({
    send: async () => ({ targetInfo: { targetId: page.targetId } }),
    detach: async () => {},
  }));
  const connect = vi.fn(async () => {
    const browser = { close: vi.fn(async () => {}) };
    browsers.push(browser);
    return {
      browser,
      context: {
        pages: () => pages.filter((page) => !page.closed),
        newCDPSession,
        newPage: async () => {
          if (pageError) throw pageError;
          const handlers = [];
          const navigated = [];
          const frame = {};
          const page = {
            closed: false, bringToFront: vi.fn(async () => {}), screenshot: vi.fn(async () => Buffer.from('jpg')),
            targetId: `target-${pages.length}`, href: null, text: '',
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
  return { connect, pages, browsers, newCDPSession };
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
  it('rejects an unreachable Hook cut before connecting a browser or uploading', async () => {
    const { id } = await projects.createProject({ name: 'Synthetic hook' });
    await projects.mutateProjectRecord(id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 258 }, publishKit: {
        links: { song: 'https://suno.com/song/12345678-abcd-4abc-8abc-123456789abc' },
        master: { renderHistoryId: current.renderHistoryId },
        exports: [{ kind: 'vertical-9x16', filename: 'late.mp4', startSec: 199, endSec: 225 }],
      },
    } }));
    const { connect } = fakeBrowser();
    const hook = adapter({ label: 'Suno Hook' });
    await expect(preparePublishDraft(id, 'sunoHook', {}, { connect, adapters: { sunoHook: hook },
      platforms: { sunoHook: { enabled: true, account: null } },
    })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/latest Suno Hook window start 3:18/) });
    expect(connect).not.toHaveBeenCalled();
    expect(hook.prepare).not.toHaveBeenCalled();
  });

  it('refuses Hook uploads at 200 MB in preview and fill before opening a browser', async () => {
    const { id } = await projects.createProject({ name: 'Synthetic hook' });
    await projects.mutateProjectRecord(id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 200 }, publishKit: {
        links: { song: 'https://suno.com/song/12345678-abcd-4abc-8abc-123456789abc' },
        master: { renderHistoryId: current.renderHistoryId },
        exports: [{ kind: 'vertical-9x16', filename: 'sized-hook.mp4', startSec: 20, endSec: 80 }],
      },
    } }));
    await mkdir(PATHS.videos, { recursive: true });
    const cut = join(PATHS.videos, 'sized-hook.mp4');
    await writeFile(cut, '');
    await truncate(cut, 200_000_000);
    const { connect } = fakeBrowser();
    const hook = adapter({ label: 'Suno Hook' });
    const readSongTitle = vi.fn(async () => '');
    const deps = { connect, readSongTitle, adapters: { sunoHook: hook }, platforms: { sunoHook: { enabled: true, account: null } } };
    const preview = await previewPublishPost(id, 'sunoHook', {}, deps);
    expect(preview).toEqual({ ready: false, problem: expect.stringMatching(/under 200 MB.*shorter.*rebuild/) });
    await expect(preparePublishDraft(id, 'sunoHook', {}, deps)).rejects.toMatchObject({
      status: 422, code: 'PUBLISH_ASSET_TOO_LARGE', message: preview.problem,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(readSongTitle).not.toHaveBeenCalled();
    expect(hook.prepare).not.toHaveBeenCalled();

    await truncate(cut, 199_999_999);
    await expect(previewPublishPost(id, 'sunoHook', {}, deps)).resolves.toMatchObject({ ready: true });
    const draft = await preparePublishDraft(id, 'sunoHook', {}, deps);
    expect(hook.prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ video: expect.objectContaining({ path: cut }) }));
    await discardPublishDraft(id, draft.id);
  });

  it("looks a Hook's song up by the title Suno shows now, and by the project's name when Suno gives none", async () => {
    const songId = '12345678-abcd-4abc-8abc-123456789abc';
    const { id } = await projects.createProject({ name: 'Example Song' });
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'vertical.mp4'), 'x');
    await projects.mutateProjectRecord(id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 200 }, publishKit: {
        links: { song: `https://suno.com/song/${songId}` },
        master: { renderHistoryId: current.renderHistoryId },
        exports: [{ kind: 'vertical-9x16', filename: 'vertical.mp4', startSec: 30, endSec: 55 }],
      },
    } }));
    const { connect } = fakeBrowser();
    const hook = adapter({ label: 'Suno Hook' });
    const deps = { connect, adapters: { sunoHook: hook }, platforms: { sunoHook: { enabled: true, account: null } } };
    // The song was renamed on Suno after the project was made.
    const readSongTitle = vi.fn(async () => 'Example Song (Renamed)');
    await preparePublishDraft(id, 'sunoHook', {}, { ...deps, readSongTitle });
    expect(readSongTitle).toHaveBeenCalledWith(songId);
    expect(hook.prepare.mock.calls[0][1]).toMatchObject({ songId, title: 'Example Song (Renamed)' });

    await preparePublishDraft(id, 'sunoHook', {}, { ...deps, readSongTitle: async () => '' });
    expect(hook.prepare.mock.calls[1][1].title).toBe('Example Song');
  });

  it('fills a Substack post on the publication named under Where you post', async () => {
    const { id } = await projects.createProject({ name: 'Release' });
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: {
      links: { youtube: 'https://youtu.be/abc' }, copy: { substack: { title: 'Song', subtitle: 'Sub', body: 'b' } },
    } } }));
    const { connect } = fakeBrowser();
    const substack = adapter({ label: 'Substack' });
    await preparePublishDraft(id, 'substack', {}, { connect, adapters: { substack }, platforms: { substack: { enabled: true, account: 'example' } } });
    expect(substack.prepare).toHaveBeenCalledWith(expect.anything(), { publication: 'example.substack.com', videoUrl: 'https://youtu.be/abc', title: 'Song', subtitle: 'Sub', body: 'b', crossLinks: ['youtube'] });
    await expect(preparePublishDraft(id, 'substack', { again: true }, { connect, adapters: { substack }, platforms: { substack: { enabled: true, account: null } } }))
      .rejects.toMatchObject({ status: 422, message: expect.stringMatching(/publication/) });
  });

  it('follows a Suno share link to its song page for the Suno post, and records the song page', async () => {
    const songId = '0a1b2c3d-1111-4222-8333-444455556666';
    const { id } = await projects.createProject({ name: 'Release' });
    const { connect } = fakeBrowser();
    const suno = adapter({ label: 'Suno' });
    const resolveUrl = vi.fn(async () => `https://suno.com/song/${songId}?sh=abc`);
    const deps = { connect, adapters: { suno }, platforms: { suno: { enabled: true, account: null } }, resolveUrl };
    const draft = await preparePublishDraft(id, 'suno', { songUrl: 'https://suno.com/s/AbCdEf123' }, deps);
    expect(resolveUrl).toHaveBeenCalledWith('https://suno.com/s/AbCdEf123', expect.objectContaining({ allowUrl: expect.any(Function) }));
    expect(suno.prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ songUrl: `https://suno.com/song/${songId}` }));
    expect(draft.songUrl).toBe(`https://suno.com/song/${songId}`);

    const dead = { ...deps, resolveUrl: vi.fn(async () => null) };
    await expect(preparePublishDraft(id, 'suno', { songUrl: 'https://suno.com/s/Gone1234' }, dead))
      .rejects.toMatchObject({ status: 422, message: expect.stringMatching(/suno\.com\/song/) });

    const { post } = await recordPublishPost(id, 'suno', { url: 'https://suno.com/s/AbCdEf123' }, { resolveUrl });
    expect(post.url).toBe(`https://suno.com/song/${songId}`);
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

  it('starts a replaced post over with only the links its replacement carries, and unlinks it from the others', async () => {
    const id = await readyProject();
    await recordPublishPost(id, 'youtube', { url: 'https://youtu.be/old' });
    await recordPublishPost(id, 'x', { url: 'https://x.com/a/status/1', links: ['youtube'] });
    const { post, project } = await recordPublishPost(id, 'youtube', { url: 'https://youtu.be/new', links: [] });
    expect(post.links).toEqual([]);
    expect(project.publishKit.posts.x.links).toEqual([]);
  });

  it('records the post the director makes by hand in the filled tab, and nothing else they browse to', async () => {
    const id = await readyProject();
    const { connect, pages, browsers } = fakeBrowser();
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
      expect(browsers[0].close).toHaveBeenCalledOnce();
      expect(await listPublishDrafts(id, { connect })).toEqual([]);
    } finally {
      musicVideoEvents.off('publish-draft', onEvent);
    }
  });

  it.each([true, false])('keeps only the current draft after a detected-post write fails (replacement: %s)', async (replace) => {
    const id = await readyProject();
    const { connect, pages, browsers } = fakeBrowser();
    const url = 'https://stacker.news/items/123';
    const deps = { connect, platforms, adapters: { stackerNews: adapter({ findPost: async () => url }) } };
    const original = await preparePublishDraft(id, 'stackerNews', {}, deps);
    const writeStarted = Promise.withResolvers();
    const write = Promise.withResolvers();
    const mutation = vi.spyOn(projects, 'mutateProjectRecord').mockImplementationOnce(() => {
      writeStarted.resolve();
      return write.promise;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await pages[0].navigate(url);
      await writeStarted.promise;
      const current = replace ? await preparePublishDraft(id, 'stackerNews', {}, deps) : original;
      write.reject(new Error('Post save failed'));
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('Post save failed')));

      expect(await listPublishDrafts(id, deps)).toEqual([expect.objectContaining({ draftId: current.draftId, state: 'open' })]);
      expect(pages[0].closed).toBe(replace);
      expect(browsers[0].close).toHaveBeenCalledTimes(replace ? 1 : 0);
      if (replace) expect(pages[1].closed).toBe(false);
      else {
        const { post } = await recordPublishPost(id, 'stackerNews', { url });
        expect(post.url).toBe(url);
      }
      await discardPublishDraft(id, current.draftId, deps);
    } finally {
      write.resolve();
      warn.mockRestore();
      mutation.mockRestore();
    }
  });

  it('says what a fill waits on while another holds the PortOS Browser, and what each fill is doing', async () => {
    const first = await readyProject();
    const second = await readyProject();
    const { connect, pages } = fakeBrowser();
    let release;
    const held = new Promise((r) => { release = r; });
    const slow = adapter({ label: 'X thread', prepare: vi.fn(async () => {
      await step('X thread', 'wait for the uploads', () => held, { status: 'uploading the video to X' });
      return {};
    }) });
    const events = [];
    const onEvent = (e) => { if (e.state === 'queued' || e.state === 'filling') events.push(e); };
    musicVideoEvents.on('publish-draft', onEvent);
    try {
      const holding = preparePublishDraft(first, 'stackerNews', {}, { connect, adapters: { stackerNews: slow }, platforms });
      await vi.waitFor(() => expect(events.some((e) => e.message === 'X thread: uploading the video to X')).toBe(true));
      const waiting = preparePublishDraft(second, 'stackerNews', {}, { connect, adapters: { stackerNews: adapter() }, platforms });
      await vi.waitFor(() => expect(events).toContainEqual({ projectId: second, target: 'stackerNews', state: 'queued', message: 'Waiting for X thread to finish (uploading the video to X)' }));
      release();
      await Promise.all([holding, waiting]);
      expect(events.filter((e) => e.projectId === second).map((e) => e.state)).toEqual(['queued', 'filling']);
      // Each step brings its own tab back to the front (a hidden tab stalls clicks).
      expect(pages[0].bringToFront).toHaveBeenCalledTimes(2);
    } finally {
      musicVideoEvents.off('publish-draft', onEvent);
    }
  });

  it('tells the director to leave the tab in front when a step times out', async () => {
    const id = await readyProject();
    const { connect } = fakeBrowser();
    const stalled = adapter({ label: 'Facebook', prepare: vi.fn(() => step('Facebook', 'open the post composer', async () => { throw new Error('locator.click: Timeout 60000ms exceeded.'); })) });
    await expect(preparePublishDraft(id, 'stackerNews', {}, { connect, adapters: { stackerNews: stalled }, platforms }))
      .rejects.toThrow('Facebook: open the post composer (locator.click: Timeout 60000ms exceeded.). Leave the PortOS Browser on the tab it opened while it fills, then Fill again');
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

  it('replaces the earlier draft when fills overlap for the same project and target', async () => {
    const id = await readyProject();
    const { connect, pages, browsers } = fakeBrowser();
    const held = Promise.withResolvers();
    const queued = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const stackerNews = adapter();
    stackerNews.prepare.mockImplementationOnce(async () => {
      entered.resolve();
      await held.promise;
      return {};
    });
    const deps = { connect, adapters: { stackerNews }, platforms };
    const onDraft = (event) => {
      if (event.projectId === id && event.state === 'queued') queued.resolve();
    };
    musicVideoEvents.on('publish-draft', onDraft);
    const first = preparePublishDraft(id, 'stackerNews', {}, deps);
    let second;
    try {
      await entered.promise;
      second = preparePublishDraft(id, 'stackerNews', {}, deps);
      await queued.promise;
      expect(connect).toHaveBeenCalledTimes(1);
      held.resolve();
      const [original, replacement] = await Promise.all([first, second]);

      expect(await listPublishDrafts(id, { connect })).toEqual([replacement]);
      expect(await discardPublishDraft(id, original.draftId)).toBe(false);
      expect(pages.map((page) => page.closed)).toEqual([true, false]);
      expect(browsers[0].close).toHaveBeenCalledOnce();
    } finally {
      held.resolve();
      musicVideoEvents.off('publish-draft', onDraft);
      await Promise.allSettled([first, second]);
    }
  });

  it.each(['connect', 'newPage', 'prepare'])('preserves the previous draft if replacement fails at %s', async (stage) => {
    const id = await readyProject();
    const original = fakeBrowser();
    const draft = await preparePublishDraft(id, 'stackerNews', {}, {
      connect: original.connect, adapters: { stackerNews: adapter() }, platforms,
    });
    const err = new Error('Replacement failed');
    const failed = fakeBrowser({ pageError: stage === 'newPage' ? err : undefined });
    const stackerNews = adapter();
    if (stage === 'connect') failed.connect.mockRejectedValueOnce(err);
    if (stage === 'prepare') stackerNews.prepare.mockRejectedValueOnce(err);

    await expect(preparePublishDraft(id, 'stackerNews', {}, {
      connect: failed.connect, adapters: { stackerNews }, platforms,
    })).rejects.toBe(err);

    expect(await listPublishDrafts(id)).toEqual([draft]);
    expect(original.pages[0].closed).toBe(false);
    expect(original.browsers[0].close).not.toHaveBeenCalled();
    if (stage !== 'connect') expect(failed.browsers[0].close).toHaveBeenCalledOnce();
    if (stage === 'prepare') expect(failed.pages[0].closed).toBe(true);
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
      expect(browsers[1].close).toHaveBeenCalledOnce();
      expect(pages[0].closed).toBe(false);
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

  it.each(['discard', 'fill again'])('targets only the intended detached draft on %s with duplicate composer URLs', async (action) => {
    vi.useFakeTimers();
    try {
      const otherProject = await readyProject();
      const id = await readyProject();
      const { connect, pages } = fakeBrowser();
      const composer = 'https://example.com/composer';
      const stackerNews = adapter({ prepare: async (page) => { page.href = composer; return {}; } });
      const deps = { connect, adapters: { stackerNews }, platforms };
      const other = await preparePublishDraft(otherProject, 'stackerNews', {}, deps);
      const draft = await preparePublishDraft(id, 'stackerNews', {}, deps);
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

      if (action === 'discard') {
        expect(await discardPublishDraft(id, draft.draftId, deps)).toBe(true);
        expect(await listPublishDrafts(id, deps)).toEqual([]);
      } else {
        const replacement = await preparePublishDraft(id, 'stackerNews', {}, deps);
        expect(pages[2].closed).toBe(false);
        expect(await listPublishDrafts(id, deps)).toEqual([replacement]);
      }
      expect(pages[0].closed).toBe(false);
      expect(pages[1].closed).toBe(true);
      expect(await listPublishDrafts(otherProject, deps)).toEqual([other]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['discard', 'fill again'])('reports a hand-closed original and preserves a manual composer on %s', async (action) => {
    vi.useFakeTimers();
    try {
      const id = await readyProject();
      const { connect, pages, browsers } = fakeBrowser();
      const composer = 'https://example.com/composer';
      const stackerNews = adapter({ prepare: async (page) => { page.href = composer; return {}; } });
      const deps = { connect, adapters: { stackerNews }, platforms };
      const original = await preparePublishDraft(id, 'stackerNews', {}, deps);
      const { context } = await connect();
      const manual = await context.newPage();
      manual.href = composer;
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      await pages[0].close();
      expect(await listPublishDrafts(id, deps)).toEqual([{ ...original, state: 'closed' }]);

      if (action === 'discard') {
        expect(await discardPublishDraft(id, original.draftId, deps)).toBe(true);
        expect(await listPublishDrafts(id, deps)).toEqual([]);
      } else {
        const replacement = await preparePublishDraft(id, 'stackerNews', {}, deps);
        expect(pages[2].closed).toBe(false);
        expect(browsers.at(-1).close).not.toHaveBeenCalled();
        expect(await listPublishDrafts(id, deps)).toEqual([replacement]);
      }
      expect(manual.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the original detached tab after it moves to another URL', async () => {
    vi.useFakeTimers();
    try {
      const id = await readyProject();
      const { connect, pages } = fakeBrowser();
      const deps = { connect, adapters: { stackerNews: adapter() }, platforms };
      const draft = await preparePublishDraft(id, 'stackerNews', {}, deps);
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      pages[0].href = 'https://example.net/elsewhere';
      expect(await listPublishDrafts(id, deps)).toEqual([draft]);
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

  it('disconnects each detached lookup once while listing overlaps a pending discard', async () => {
    vi.useFakeTimers();
    try {
      const id = await readyProject();
      const { connect, pages, browsers, newCDPSession } = fakeBrowser();
      const draft = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters: { stackerNews: adapter() }, platforms });
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

      const tab = pages[0];
      const finishClose = Promise.withResolvers();
      const listSession = { browser: { close: vi.fn(async () => {}) }, context: { pages: () => [tab], newCDPSession } };
      const discardBrowser = { close: vi.fn(async () => {}) };
      const discardPage = {
        targetId: tab.targetId,
        url: tab.url,
        close: vi.fn(async () => {
          await finishClose.promise;
          if (discardBrowser.close.mock.calls.length) throw new Error('Discard session disconnected');
          await tab.close();
        }),
      };
      const discardSession = { browser: discardBrowser, context: { pages: () => [discardPage], newCDPSession } };

      const listing = listPublishDrafts(id, { connect: async () => listSession });
      const discarding = discardPublishDraft(id, draft.draftId, { connect: async () => discardSession });
      const listed = await listing;
      const tabOpenAfterListing = !tab.closed;
      finishClose.resolve();

      expect(await discarding).toBe(true);
      expect(listed).toEqual([draft]);
      expect(tabOpenAfterListing).toBe(true);
      expect(tab.closed).toBe(true);
      expect(browsers[0].close).toHaveBeenCalledOnce();
      expect(listSession.browser.close).toHaveBeenCalledOnce();
      expect(discardBrowser.close).toHaveBeenCalledOnce();
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

  it('leaves an interrupted editor open and disconnects without treating it as a finished draft', async () => {
    const id = await readyProject();
    const { connect, pages, browsers } = fakeBrowser();
    const err = Object.assign(new Error('Review the open tab'), { code: 'PUBLISH_EDIT_INTERRUPTED' });
    const adapters = { stackerNews: adapter({ prepare: vi.fn(async () => { throw err; }) }) };
    await expect(preparePublishDraft(id, 'stackerNews', {}, { connect, adapters, platforms })).rejects.toBe(err);
    expect(pages[0].closed).toBe(false);
    expect(browsers[0].close).toHaveBeenCalled();
    expect(await listPublishDrafts(id, { connect })).toEqual([]);
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

  it('records the links a filled draft carried when its link is pasted', async () => {
    const id = await readyProject();
    const { connect } = fakeBrowser();
    await preparePublishDraft(id, 'stackerNews', { territory: 'art' }, { connect, adapters: { stackerNews: adapter() }, platforms });
    const { post } = await recordPublishPost(id, 'stackerNews', { url: 'https://stacker.news/items/5' });
    expect(post.links).toEqual(['youtube']);
  });

  it('backfills a post made before the others: fills the missing links, leaves the tab for the director, then counts them once Saved', async () => {
    const id = await readyProject();
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { ...current.publishKit, posts: {
      // Posted before YouTube existed, and before posts recorded their links.
      x: { url: 'https://x.com/example/status/42', postedAt: '2026-01-01T00:00:00Z' },
      youtube: { url: 'https://youtu.be/abc', postedAt: '2026-01-01T01:00:00Z', links: [] },
      stackerNews: { url: 'https://stacker.news/items/7', postedAt: '2026-01-01T02:00:00Z', links: ['youtube'] },
    } } } }));
    const { connect, pages, browsers } = fakeBrowser();
    const x = { label: 'X', prepare: vi.fn(async () => ({ leftForYou: ['Reply'] })) };
    const filled = await prepareCrossLinkEdit(id, 'x', { connect, crossLinkAdapters: { x } });
    expect(x.prepare.mock.calls[0][1]).toMatchObject({ target: 'x', url: 'https://x.com/example/status/42', text: 'Music video: https://youtu.be/abc\nStacker News: https://stacker.news/items/7' });
    expect(filled).toMatchObject({ target: 'x', links: ['youtube', 'stackerNews'], summary: { leftForYou: ['Reply'] }, screenshot: expect.stringMatching(/^data:image\/jpeg/) });
    expect(pages[0].closed).toBe(false);
    expect(browsers[0].close).toHaveBeenCalled();

    const { post } = await recordPublishPost(id, 'x', { links: filled.links });
    expect(post.links).toEqual(['youtube', 'stackerNews']);
    await expect(prepareCrossLinkEdit(id, 'x', { connect, crossLinkAdapters: { x } })).rejects.toMatchObject({ status: 409, code: 'PUBLISH_CROSS_LINKS_CURRENT' });
    await expect(prepareCrossLinkEdit(id, 'suno', { connect, crossLinkAdapters: { suno: x } })).rejects.toMatchObject({ status: 422 });
  });

  it('disconnects the cross-link browser session when opening its tab fails', async () => {
    const id = await readyProject();
    await recordPublishPost(id, 'x', { url: 'https://x.com/example/status/42', links: [] });
    await recordPublishPost(id, 'youtube', { url: 'https://youtu.be/abc' });
    const pageError = new Error('Could not open a tab');
    const { connect, browsers } = fakeBrowser({ pageError });
    const x = adapter({ label: 'X' });

    await expect(prepareCrossLinkEdit(id, 'x', { connect, crossLinkAdapters: { x } })).rejects.toBe(pageError);

    expect(browsers[0].close).toHaveBeenCalledOnce();
    expect(x.prepare).not.toHaveBeenCalled();
  });

  it('turns cross-links in new drafts off and on', async () => {
    const id = await readyProject();
    expect((await setPublishCrossLinks(id, false)).project.publishKit).toMatchObject({ crossLinks: false, copy: { stackerNews: { title: 'Song' } } });
    expect((await setPublishCrossLinks(id, true)).project.publishKit.crossLinks).toBe(true);
  });
});
