/**
 * Stacker News adapter: login detection, the url read-back that repairs a stray
 * keystroke, and the post link match. Driven by a fake page, no Chromium.
 */
import { describe, expect, it } from 'vitest';
import { stackerNewsAdapter } from './stackerNews.js';

function fakePage({ signedIn = true, urlValue = null } = {}) {
  const log = [];
  const filled = {};
  const element = (sel) => {
    const el = {
      first: () => el,
      filter: () => el,
      count: async () => (/input\[name=title\]/.test(sel) && !signedIn ? 0 : 1),
      fill: async (value) => { filled[sel] = value; log.push(['fill', sel, value]); },
      inputValue: async () => (sel === 'input[name=url]' && urlValue !== null ? urlValue : filled[sel] ?? ''),
      click: async () => { log.push(['click', sel]); },
    };
    return el;
  };
  return {
    log,
    goto: async (to) => { log.push(['goto', to]); },
    waitForTimeout: async () => {},
    locator: (sel) => element(sel),
    evaluate: async (fn, arg) => {
      if (Array.isArray(arg)) { log.push(['paste', arg[0], arg[1]]); return true; }
      return 'post 10 sats';
    },
  };
}

const payload = { territory: 'art', title: 'A music video', url: 'https://example.com/v', body: 'Body text' };

describe('Stacker News adapter', () => {
  it('asks for sign-in when the title field is absent', async () => {
    await expect(stackerNewsAdapter.prepare(fakePage({ signedIn: false }), payload))
      .rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
  });

  it('opens the territory link-post form and reports the cost', async () => {
    const page = fakePage();
    const summary = await stackerNewsAdapter.prepare(page, payload);
    expect(page.log[0]).toEqual(['goto', 'https://stacker.news/~art/post?type=link']);
    expect(summary).toMatchObject({ territory: 'art', url: payload.url, cost: 'post 10 sats' });
  });

  it('refills the url when a stray keystroke changed it', async () => {
    const page = fakePage({ urlValue: 'https://example.com/vX' });
    await stackerNewsAdapter.prepare(page, payload);
    const urlFills = page.log.filter(([kind, sel]) => kind === 'fill' && sel === 'input[name=url]');
    expect(urlFills).toHaveLength(2);
  });

  it('leaves the url alone when the read-back matches', async () => {
    const page = fakePage();
    await stackerNewsAdapter.prepare(page, payload);
    expect(page.log.filter(([kind, sel]) => kind === 'fill' && sel === 'input[name=url]')).toHaveLength(1);
  });

  describe('findPost', () => {
    const landed = (url, shown = true) => ({ url: () => url, waitForFunction: async () => { if (!shown) throw new Error('timeout'); } });

    it('resolves an /items/ page that shows the title', async () => {
      expect(await stackerNewsAdapter.findPost(landed('https://stacker.news/items/123456'), payload)).toBe('https://stacker.news/items/123456');
    });

    it('ignores the post form, other pages and a page without the title', async () => {
      expect(await stackerNewsAdapter.findPost(landed('https://stacker.news/~art/post?type=link'), payload)).toBeNull();
      expect(await stackerNewsAdapter.findPost(landed('https://stacker.news/items/abc'), payload)).toBeNull();
      expect(await stackerNewsAdapter.findPost(landed('https://stacker.news/items/9', false), payload)).toBeNull();
    });
  });
});
