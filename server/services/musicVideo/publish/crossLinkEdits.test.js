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
});
