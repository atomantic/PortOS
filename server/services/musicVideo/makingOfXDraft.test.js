import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('making-of-x-draft-test-');
vi.mock('../../lib/paths.js', async (actual) => makePathsProxy(await actual(), { dataRoot: ROOT }));
vi.mock('../../lib/fileUtils.js', async (actual) => makePathsProxy(await actual(), { dataRoot: ROOT }));
vi.mock('../settings.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { getSettings: vi.fn(async () => ({})), settingsEvents: new EventEmitter() };
});

const { PATHS } = await import('../../lib/fileUtils.js');
const projects = await import('./projects.js');
const { captureMakingOfItem, createMakingOfPost, updateMakingOfPost } = await import('./makingOfStory.js');
const { musicVideoEvents } = await import('./events.js');
const {
  __resetMakingOfXDrafts,
  buildMakingOfXThreadPayload,
  detachMakingOfXDraftsForPost,
  discardMakingOfXDraft,
  listMakingOfXDrafts,
  prepareMakingOfXDraft,
} = await import('./makingOfXDraft.js');

function fakeBrowser({ screenshotBuf = Buffer.from('jpg') } = {}) {
  const pages = [];
  let closedBrowser = false;
  const newPage = async () => {
    let closed = false;
    const listeners = new Map();
    const page = {
      isClosed: () => closed,
      bringToFront: vi.fn(async () => {}),
      screenshot: vi.fn(async () => screenshotBuf),
      close: vi.fn(async () => {
        closed = true;
        listeners.get('close')?.();
      }),
      once: (event, fn) => { listeners.set(event, fn); },
    };
    pages.push(page);
    return page;
  };
  const context = {
    newPage,
    pages: () => pages.filter((p) => !p.isClosed()),
    newCDPSession: async (page) => ({
      send: async () => ({ targetInfo: { targetId: `target-${pages.indexOf(page)}` } }),
      detach: async () => {},
    }),
  };
  const browser = {
    close: vi.fn(async () => { closedBrowser = true; }),
    get closed() { return closedBrowser; },
  };
  return { browser, context, pages };
}

afterEach(() => {
  __resetMakingOfXDrafts();
});

afterAll(cleanupTempDataRoots);

describe('Making-Of X thread draft service', () => {
  it('builds a multi-part X payload with multiple mixed images and videos per post', async () => {
    mkdirSync(PATHS.images, { recursive: true });
    mkdirSync(PATHS.videos, { recursive: true });
    writeFileSync(join(PATHS.images, 'frame-1.png'), 'img1');
    writeFileSync(join(PATHS.images, 'frame-2.png'), 'img2');
    writeFileSync(join(PATHS.videos, 'clip-1.mp4'), 'vid1');

    const items = [
      { id: 'moi-img-1', kind: 'image', assetId: 'frame-1.png', label: 'Frame 1', role: 'before', tags: [], note: '', sourceUrl: '', capturedAt: '' },
      { id: 'moi-img-2', kind: 'image', assetId: 'frame-2.png', label: 'Frame 2', role: 'after', tags: [], note: '', sourceUrl: '', capturedAt: '' },
      { id: 'moi-vid-1', kind: 'video', assetId: 'vid-job-1', label: 'Final clip', role: 'final', tags: [], note: '', sourceUrl: '', capturedAt: '' },
    ];
    const post = {
      id: 'mop-1',
      title: 'Thread title',
      status: 'staged',
      platform: 'x',
      tags: [],
      summary: '',
      body: 'Part 1: Hook\n\n---\n\nPart 2: Payoff',
      itemIds: ['moi-img-1', 'moi-vid-1', 'moi-img-2'],
      partItemIds: [['moi-img-1', 'moi-vid-1'], ['moi-img-2']],
      publishedUrl: '',
      publishedAt: null,
      updatedAt: '',
    };

    const payload = await buildMakingOfXThreadPayload(post, items, {
      getVideoHistoryItem: async (id) => (id === 'vid-job-1' ? { id, filename: 'clip-1.mp4' } : null),
    });
    expect(payload.attachments).toBe(3);
    expect(payload.posts).toHaveLength(2);
    expect(payload.posts[0].text).toBe('Part 1: Hook');
    expect(payload.posts[0].mediaFiles.map((m) => m.name)).toEqual(['frame-1.png', 'clip-1.mp4']);
    expect(payload.posts[1].text).toBe('Part 2: Payoff');
    expect(payload.posts[1].mediaFiles.map((m) => m.name)).toEqual(['frame-2.png']);

    // Optional closing post linking to the published X music video (skipped if already present).
    const withLink = await buildMakingOfXThreadPayload(post, items, {
      getVideoHistoryItem: async (id) => (id === 'vid-job-1' ? { id, filename: 'clip-1.mp4' } : null),
      includeVideoLink: true,
      projectName: 'Demo Film',
      videoXUrl: 'https://x.com/example/status/9001',
    });
    expect(withLink.posts).toHaveLength(3);
    expect(withLink.posts[2]).toEqual({ text: 'Watch the finished "Demo Film" music video:\nhttps://x.com/example/status/9001' });
    expect(withLink.videoLink).toBe('https://x.com/example/status/9001');

    const alreadyLinked = await buildMakingOfXThreadPayload(
      { ...post, body: `${post.body}\n\nhttps://x.com/example/status/9001` },
      items,
      {
        getVideoHistoryItem: async (id) => (id === 'vid-job-1' ? { id, filename: 'clip-1.mp4' } : null),
        includeVideoLink: true,
        projectName: 'Demo Film',
        videoXUrl: 'https://x.com/example/status/9001',
      },
    );
    expect(alreadyLinked.posts).toHaveLength(2);
    expect(alreadyLinked.videoLink).toBeNull();
  });

  it('fills an X draft for review without ever submitting, guards reposts, and supports discard + posted detach', async () => {
    mkdirSync(PATHS.images, { recursive: true });
    writeFileSync(join(PATHS.images, 'still-a.png'), 'png');
    writeFileSync(join(PATHS.images, 'still-b.png'), 'png');

    const project = await projects.createProject({ name: 'Draft Test Film' });
    const a = await captureMakingOfItem(project.id, { kind: 'image', assetId: 'still-a.png', label: 'Still A', role: 'before' });
    const b = await captureMakingOfItem(project.id, { kind: 'image', assetId: 'still-b.png', label: 'Still B', role: 'after' });
    const created = await createMakingOfPost(project.id, {
      title: 'Town poles breakdown',
      status: 'staged',
      platform: 'x',
      body: 'First post text\n\n---\n\nSecond post text',
      itemIds: [a.item.id, b.item.id],
      partItemIds: [[a.item.id, b.item.id], []],
    });

    const events = [];
    const onEvent = (e) => events.push(e);
    musicVideoEvents.on('making-of-draft', onEvent);

    const env = fakeBrowser();
    const adapter = {
      label: 'X',
      prepare: vi.fn(async (_page, payload) => ({ account: 'exampleuser', posts: payload.posts.length, lengths: [15, 16] })),
      submit: vi.fn(),
    };

    try {
      const draft = await prepareMakingOfXDraft(project.id, created.post.id, {}, {
        connect: async () => env,
        adapter,
        platforms: { x: { enabled: true, account: 'exampleuser' } },
      });

      expect(draft.manualPublication).toBe(true);
      expect(draft.state).toBe('open');
      expect(draft.screenshot).toMatch(/^data:image\/jpeg;base64,/);
      expect(draft.summary).toEqual({
        account: 'exampleuser',
        posts: 2,
        lengths: [15, 16],
        attachments: 2,
        mediaPerPost: [2, 0],
      });
      expect(adapter.prepare).toHaveBeenCalledTimes(1);
      expect(adapter.submit).not.toHaveBeenCalled();

      const listed = await listMakingOfXDrafts(project.id, { connect: async () => env });
      expect(listed).toHaveLength(1);
      expect(listed[0].draftId).toBe(draft.draftId);

      // Discard closes the tab and removes the draft.
      expect(await discardMakingOfXDraft(project.id, draft.draftId)).toBe(true);
      expect(env.pages[0].close).toHaveBeenCalledTimes(1);
      expect(await listMakingOfXDrafts(project.id)).toEqual([]);

      // Mark posted -> refuses duplicate fill unless `{ again: true }`.
      await updateMakingOfPost(project.id, created.post.id, {
        status: 'posted',
        publishedUrl: 'https://x.com/exampleuser/status/999',
      });
      await expect(prepareMakingOfXDraft(project.id, created.post.id, {}, {
        connect: async () => env,
        adapter,
        platforms: { x: { enabled: true } },
      })).rejects.toMatchObject({ code: 'PUBLISH_ALREADY_POSTED' });

      // Explicit `{ again: true }` succeeds, then detach leaves the tab open when marked posted.
      const env2 = fakeBrowser();
      const second = await prepareMakingOfXDraft(project.id, created.post.id, { again: true }, {
        connect: async () => env2,
        adapter,
        platforms: { x: { enabled: true } },
      });
      expect(second.state).toBe('open');
      await detachMakingOfXDraftsForPost(project.id, created.post.id);
      expect(env2.pages[0].close).not.toHaveBeenCalled();
      expect(env2.browser.close).toHaveBeenCalledTimes(1);
      expect(await listMakingOfXDrafts(project.id)).toEqual([]);
      expect(events.map((e) => e.state)).toContain('posted');
    } finally {
      musicVideoEvents.off('making-of-draft', onEvent);
    }
  });

  it('rejects non-X posts and missing media files cleanly', async () => {
    const project = await projects.createProject({ name: 'Error Cases Film' });
    const missing = await captureMakingOfItem(project.id, { kind: 'image', assetId: 'does-not-exist.png', label: 'Ghost', role: 'fail' });
    const xPost = await createMakingOfPost(project.id, {
      title: 'Missing file post',
      status: 'staged',
      platform: 'x',
      body: 'Body text',
      itemIds: [missing.item.id],
      partItemIds: [[missing.item.id]],
    });
    const ytPost = await createMakingOfPost(project.id, {
      title: 'YouTube only',
      status: 'staged',
      platform: 'youtube',
      body: 'Body text',
    });

    await expect(prepareMakingOfXDraft(project.id, xPost.post.id, {}, { platforms: {} }))
      .rejects.toMatchObject({ code: 'MAKING_OF_ASSET_MISSING', status: 422 });
    await expect(prepareMakingOfXDraft(project.id, ytPost.post.id, {}, { platforms: {} }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });
});
