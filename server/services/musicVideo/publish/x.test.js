import { describe, it, expect, vi } from 'vitest';

vi.mock('./xTyping.js', () => ({ typeXText: vi.fn(async (page, selector) => { page.calls.typed.push(selector); }) }));
import { xAdapter } from './x.js';

// A page whose modal composer (when `dialog`) sits over the home timeline's inline one; both carry
// tweetTextarea_0. `dialogDelay` makes the modal's editor appear only after a while (X still hydrating).
const fakePage = ({ dialog, dialogDelay = 0 }) => {
  const calls = { typed: [], clicked: [], waited: [], files: [] };
  const born = Date.now();
  const page = {
    calls,
    goto: async () => {},
    url: () => 'https://x.com/compose/post',
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      if (Array.isArray(arg) && typeof arg[0] === 'number') return Array.from({ length: arg[0] }, () => 5);
      return 'example';
    },
    waitForFunction: async (_fn, scope) => { calls.waited.push(scope); },
    locator: (sel) => {
      const isDialog = sel.startsWith('[role=dialog]');
      const waitFor = async ({ timeout } = {}) => {
        if (!isDialog) return;
        if (!dialog) throw new Error('timeout');
        const left = dialogDelay - (Date.now() - born);
        if (left > (timeout ?? Infinity)) throw new Error('timeout');
        if (left > 0) await new Promise((r) => setTimeout(r, left));
      };
      return {
        waitFor: async (o) => { calls.waited.push(sel); return waitFor(o); },
        // Playwright strict mode: a bare click on a selector matching several elements throws. From post 3 on,
        // every post carries its own addButton, so only .last() (the newest post) may be clicked.
        click: async () => {
          if (sel.includes("addButton") && calls.clicked.filter((c) => c.includes("addButton")).length >= 1) throw new Error("strict mode violation: resolved to 2 elements");
          calls.clicked.push(sel);
        },
        last: () => ({ click: async () => { calls.clicked.push(sel); } }),
        first: () => ({ waitFor, setInputFiles: async (paths) => { calls.files.push({ sel, paths }); } }),
      };
    },
  };
  return page;
};

describe('X composer scope', () => {
  it('scopes every composer selector to the modal when /compose/post opens over the timeline', async () => {
    const page = fakePage({ dialog: true });
    await xAdapter.prepare(page, { posts: [{ text: 'one' }, { text: 'two' }] });
    expect(page.calls.typed).toEqual(['[role=dialog] [data-testid=tweetTextarea_0]', '[role=dialog] [data-testid=tweetTextarea_1]']);
    expect(page.calls.clicked).toContain('[role=dialog] [data-testid=addButton]');
    expect(page.calls.waited).toContain('[role=dialog] ');
  });

  it('adds a third post through the newest add-post button when earlier posts each render one', async () => {
    const page = fakePage({ dialog: true });
    await xAdapter.prepare(page, { posts: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] });
    expect(page.calls.typed).toHaveLength(3);
  });

  it('waits for a modal that hydrates late instead of falling back to unscoped selectors', async () => {
    const page = fakePage({ dialog: true, dialogDelay: 50 });
    await xAdapter.prepare(page, { posts: [{ text: 'one' }] });
    expect(page.calls.typed).toEqual(['[role=dialog] [data-testid=tweetTextarea_0]']);
  });

  it('leaves selectors unscoped for a full-page composer', async () => {
    const page = fakePage({ dialog: false });
    await xAdapter.prepare(page, { posts: [{ text: 'one' }] });
    expect(page.calls.typed).toEqual(['[data-testid=tweetTextarea_0]']);
  });

  it('fills the composer without ever pressing the Post button', async () => {
    const page = fakePage({ dialog: true });
    await xAdapter.prepare(page, { posts: [{ text: 'one' }, { text: 'two' }] });
    expect(page.calls.clicked.filter((c) => c.includes('tweetButton'))).toEqual([]);
  });

  it('attaches multiple mixed image and video files to a single post via mediaFiles', async () => {
    const page = fakePage({ dialog: true });
    await xAdapter.prepare(page, {
      posts: [
        { text: 'part 1', mediaFiles: [{ path: '/tmp/a.png' }, { path: '/tmp/b.mp4' }] },
        { text: 'part 2', media: { path: '/tmp/c.png' } },
      ],
    });
    expect(page.calls.files).toEqual([
      { sel: '[role=dialog] input[data-testid=fileInput]', paths: ['/tmp/a.png', '/tmp/b.mp4'] },
      { sel: '[role=dialog] input[data-testid=fileInput]', paths: '/tmp/c.png' },
    ]);
    expect(page.calls.clicked.filter((c) => c.includes('tweetButton'))).toEqual([]);
  });
});
