import { describe, it, expect } from 'vitest';
import { xAdapter } from './x.js';

// A page whose modal composer (when `dialog`) sits over the home timeline's inline one; both carry
// tweetTextarea_0. `dialogDelay` makes the modal's editor appear only after a while (X still hydrating).
const fakePage = ({ dialog, dialogDelay = 0 }) => {
  const calls = { pasted: [], clicked: [], waited: [] };
  const born = Date.now();
  const page = {
    calls,
    goto: async () => {},
    url: () => 'https://x.com/compose/post',
    waitForTimeout: async () => {},
    waitForURL: async () => { throw new Error('stop here'); },
    evaluate: async (fn, arg) => {
      if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string') { calls.pasted.push(arg[0]); return true; }
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
        click: async () => { calls.clicked.push(sel); },
        first: () => ({ waitFor, setInputFiles: async () => {} }),
      };
    },
  };
  return page;
};

describe('X composer scope', () => {
  it('scopes every composer selector to the modal when /compose/post opens over the timeline', async () => {
    const page = fakePage({ dialog: true });
    await xAdapter.prepare(page, { posts: [{ text: 'one' }, { text: 'two' }] });
    expect(page.calls.pasted).toEqual(['[role=dialog] [data-testid=tweetTextarea_0]', '[role=dialog] [data-testid=tweetTextarea_1]']);
    expect(page.calls.clicked).toContain('[role=dialog] [data-testid=addButton]');
    expect(page.calls.waited).toContain('[role=dialog] ');
  });

  it('waits for a modal that hydrates late instead of falling back to unscoped selectors', async () => {
    const page = fakePage({ dialog: true, dialogDelay: 50 });
    await xAdapter.prepare(page, { posts: [{ text: 'one' }] });
    expect(page.calls.pasted).toEqual(['[role=dialog] [data-testid=tweetTextarea_0]']);
  });

  it('leaves selectors unscoped for a full-page composer', async () => {
    const page = fakePage({ dialog: false });
    await xAdapter.prepare(page, { posts: [{ text: 'one' }] });
    expect(page.calls.pasted).toEqual(['[data-testid=tweetTextarea_0]']);
  });

  it('presses the modal\'s Post button on submit, not the timeline\'s', async () => {
    const page = fakePage({ dialog: true });
    await xAdapter.submit(page, { posts: [{ text: 'one' }] }).catch(() => {});
    expect(page.calls.clicked).toEqual(['[role=dialog] [data-testid=tweetButton]']);
  });
});
