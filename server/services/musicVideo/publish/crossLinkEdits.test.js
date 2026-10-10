/**
 * Backfill cross-link edits against fake pages: each fills only what the post
 * lacks and leaves the save/reply press to the director.
 */
import { describe, expect, it, vi } from 'vitest';
import { CROSS_LINK_ADAPTERS } from './crossLinkEdits.js';

const row = (target, url) => ({ target, url, missing: [{ target: 'stackerNews', url: 'https://stacker.news/items/7' }], text: 'Music video: https://youtu.be/abc\nStacker News: https://stacker.news/items/7' });

function fakePage({ url = 'https://example.com', text = '', count = 1 } = {}) {
  const typed = [];
  const locator = {
    first: () => locator, filter: () => locator, waitFor: vi.fn(async () => {}), click: vi.fn(async () => {}),
    innerText: vi.fn(async () => text), count: vi.fn(async () => count), isVisible: vi.fn(async () => false),
  };
  return {
    typed, goto: vi.fn(async (u) => { url = u; }), url: () => url, waitForTimeout: vi.fn(async () => {}),
    locator: () => locator, evaluate: vi.fn(async () => true),
    keyboard: { press: vi.fn(async () => {}), insertText: vi.fn(async (t) => typed.push(t)) },
  };
}

describe('cross-link edits', () => {
  it('adds only the description lines YouTube does not show yet, and never saves', async () => {
    const page = fakePage({ text: 'Story\nMusic video: https://youtu.be/abc' });
    const summary = await CROSS_LINK_ADAPTERS.youtube.prepare(page, row('youtube', 'https://youtu.be/vid123'));
    expect(page.goto.mock.calls[0][0]).toBe('https://studio.youtube.com/video/vid123/edit');
    expect(page.typed).toEqual(['\n\nStacker News: https://stacker.news/items/7']);
    expect(summary).toEqual({ added: ['Stacker News: https://stacker.news/items/7'], leftForYou: ['Save (top right)'] });
  });

  it('opens a reply to the X post with the lines prefilled', async () => {
    const page = fakePage({ text: 'Music video: https://youtu.be/abc\nStacker News: https://stacker.news/items/7' });
    const summary = await CROSS_LINK_ADAPTERS.x.prepare(page, row('x', 'https://x.com/example/status/42'));
    expect(page.goto.mock.calls[0][0]).toBe(`https://x.com/intent/post?in_reply_to=42&text=${encodeURIComponent(row('x').text)}`);
    expect(page.evaluate).not.toHaveBeenCalled(); // prefilled: nothing pasted
    expect(summary.leftForYou).toEqual(['Reply']);
  });

  it('leaves the Suno lines to paste when the song details cannot be found', async () => {
    const page = fakePage({ url: 'https://suno.com/song/12345678-abcd-4abc-8abc-123456789abc' });
    const summary = await CROSS_LINK_ADAPTERS.suno.prepare(page, row('suno', 'https://suno.com/song/12345678-abcd-4abc-8abc-123456789abc'));
    expect(summary.added).toEqual([]);
    expect(summary.leftForYou[0]).toContain('Stacker News: https://stacker.news/items/7');
  });

  it('keeps the Suno caption within its limit and leaves an overflow link for the director', async () => {
    const url = 'https://suno.com/song/12345678-abcd-4abc-8abc-123456789abc';
    const filled = [];
    const field = { waitFor: async () => {}, inputValue: async () => 'x'.repeat(480), fill: async (t) => filled.push(t) };
    const item = { isVisible: async () => true, click: async () => {}, hover: async () => {} };
    const page = fakePage({ url });
    page.locator = (sel) => (String(sel).includes('textarea') ? { first: () => field } : { first: () => item, filter: () => ({ first: () => item }), click: async () => {}, count: async () => 1 });
    const summary = await CROSS_LINK_ADAPTERS.suno.prepare(page, row('suno', url));
    expect(filled.every((t) => t.length <= 500)).toBe(true);
    expect(summary.leftForYou[0]).toContain('https://stacker.news/items/7');
  });

  it('types the missing links as a comment on the Facebook post and leaves sending it to the director', async () => {
    const pasted = [];
    const box = { click: async () => {}, evaluate: async (_fn, t) => pasted.push(t), innerText: async () => pasted.join('') };
    const page = fakePage({ count: 0 });
    page.locator = (sel) => (String(sel).includes('comment') ? { first: () => box } : { count: async () => 0 });
    const summary = await CROSS_LINK_ADAPTERS.facebook.prepare(page, row('facebook', 'https://www.facebook.com/reel/1'));
    expect(page.goto.mock.calls[0][0]).toBe('https://www.facebook.com/reel/1');
    expect(pasted).toEqual([row('facebook').text]);
    expect(summary.leftForYou).toEqual(['Enter (sends the comment)']);
  });
});
