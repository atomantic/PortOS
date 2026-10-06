import { describe, it, expect } from 'vitest';
import { xAdapter } from './x.js';

// A page whose modal composer sits over the home timeline's inline one (both carry tweetTextarea_0).
const fakePage = ({ dialog }) => {
  const calls = { pasted: [], clicked: [], waited: [] };
  const page = {
    calls,
    goto: async () => {},
    url: () => 'https://x.com/compose/post',
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      if (Array.isArray(arg) && typeof arg[1] === 'string' && arg.length === 2 && typeof arg[0] === 'string') { calls.pasted.push(arg[0]); return true; }
      if (Array.isArray(arg) && typeof arg[0] === 'number') return Array.from({ length: arg[0] }, () => 5);
      return 'example';
    },
    waitForFunction: async (_fn, scope) => { calls.waited.push(scope); },
    locator: (sel) => ({
      count: async () => (sel.startsWith('[role=dialog]') ? (dialog ? 1 : 0) : 2),
      waitFor: async () => { calls.waited.push(sel); },
      click: async () => { calls.clicked.push(sel); },
      first: () => ({ setInputFiles: async () => {} }),
    }),
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

  it('leaves selectors unscoped for a full-page composer', async () => {
    const page = fakePage({ dialog: false });
    await xAdapter.prepare(page, { posts: [{ text: 'one' }] });
    expect(page.calls.pasted).toEqual(['[data-testid=tweetTextarea_0]']);
  });
});
