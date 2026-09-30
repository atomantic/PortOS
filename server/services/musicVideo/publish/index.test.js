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
const { preparePublishDraft, submitPublishDraft, discardPublishDraft } = await import('./index.js');

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
    const draft = await preparePublishDraft(id, 'stackerNews', { territory: 'art' }, { connect, adapters });
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
    const first = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters });
    const second = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters });
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
    const draft = await preparePublishDraft(id, 'stackerNews', {}, { connect, adapters });
    pages[0].closed = true;
    await expect(submitPublishDraft(id, draft.draftId, { adapters })).rejects.toMatchObject({ code: 'PUBLISH_DRAFT_MISSING' });
    expect(adapters.stackerNews.submit).not.toHaveBeenCalled();
  });

  it('closes the tab and surfaces the adapter\'s error when a fill fails', async () => {
    const id = await readyProject();
    const { connect, pages } = fakeBrowser();
    const err = Object.assign(new Error('Sign in'), { status: 409, code: 'PUBLISH_LOGIN_REQUIRED' });
    const adapters = { stackerNews: adapter({ prepare: vi.fn(async () => { throw err; }) }) };
    await expect(preparePublishDraft(id, 'stackerNews', {}, { connect, adapters })).rejects.toBe(err);
    expect(pages[0].closed).toBe(true);
  });

  it('resolves release files to paths, and 422s before opening a tab when one is missing', async () => {
    const id = await readyProject();
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { ...current.publishKit, master: { filename: 'master.mp4' }, copy: { youtube: { title: 'Song' } } } } }));
    const { connect } = fakeBrowser();
    const adapters = { youtube: adapter({ label: 'YouTube' }) };
    await expect(preparePublishDraft(id, 'youtube', {}, { connect, adapters })).rejects.toMatchObject({ status: 422, code: 'PUBLISH_ASSET_MISSING' });
    expect(connect).not.toHaveBeenCalled();

    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'master.mp4'), 'x');
    await preparePublishDraft(id, 'youtube', {}, { connect, adapters });
    expect(adapters.youtube.prepare.mock.calls[0][1].video.path).toBe(join(PATHS.videos, 'master.mp4'));
  });
});
