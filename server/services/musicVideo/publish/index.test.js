/**
 * Posting state machine (#9282) with a fake browser and adapters: prepare
 * fills a draft in a new tab and returns its screenshot, submit posts only a
 * live draft and records the link, discard and re-prepare close the old tab.
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
const { preparePublishDraft, submitPublishDraft, discardPublishDraft, recordPublishPost } = await import('./index.js');

const platforms = { stackerNews: { enabled: true, account: null }, youtube: { enabled: true, account: null }, x: { enabled: true, account: 'antic' } };

afterAll(() => cleanupTempDataRoots());

function fakeBrowser() {
  const pages = [];
  const connect = vi.fn(async () => ({
    browser: { close: vi.fn(async () => {}) },
    context: {
      newPage: async () => {
        const page = { closed: false, bringToFront: vi.fn(async () => {}), screenshot: vi.fn(async () => Buffer.from('jpg')), isClosed() { return this.closed; }, close: vi.fn(async function close() { page.closed = true; }) };
        pages.push(page);
        return page;
      },
    },
  }));
  return { connect, pages };
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
  it('fills a draft, then posts it only on submit and records the link', async () => {
    const id = await readyProject();
    const { connect, pages } = fakeBrowser();
    const adapters = { stackerNews: adapter() };
    const draft = await preparePublishDraft(id, 'stackerNews', { territory: 'art' }, { connect, adapters, platforms });
    expect(draft).toMatchObject({ target: 'stackerNews', summary: { title: 'Song' } });
    expect(draft.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    expect(adapters.stackerNews.submit).not.toHaveBeenCalled();

    const { project, post } = await submitPublishDraft(id, draft.draftId, { adapters });
    expect(post.url).toBe('https://stacker.news/items/1');
    expect(project.publishKit.posts.stackerNews.url).toBe('https://stacker.news/items/1');
    expect(pages[0].closed).toBe(true);
    await expect(submitPublishDraft(id, draft.draftId, { adapters })).rejects.toMatchObject({ status: 409, code: 'PUBLISH_DRAFT_MISSING' });
  });

  it('closes the earlier draft when the same target is filled again, and discards on request', async () => {
    const id = await readyProject();
    const { connect, pages } = fakeBrowser();
    const adapters = { stackerNews: adapter() };
    const first = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters, platforms });
    const second = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters, platforms });
    expect(pages[0].closed).toBe(true);
    await expect(submitPublishDraft(id, first.draftId, { adapters })).rejects.toMatchObject({ code: 'PUBLISH_DRAFT_MISSING' });
    expect(await discardPublishDraft(id, second.draftId)).toBe(true);
    expect(pages[1].closed).toBe(true);
    expect(await discardPublishDraft(id, second.draftId)).toBe(false);
  });

  it('refuses a draft whose tab the director closed', async () => {
    const id = await readyProject();
    const { connect, pages } = fakeBrowser();
    const adapters = { stackerNews: adapter() };
    const draft = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters, platforms });
    pages[0].closed = true;
    await expect(submitPublishDraft(id, draft.draftId, { adapters })).rejects.toMatchObject({ code: 'PUBLISH_DRAFT_MISSING' });
    expect(adapters.stackerNews.submit).not.toHaveBeenCalled();
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
  });
});
