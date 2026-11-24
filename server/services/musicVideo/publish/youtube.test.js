/**
 * YouTube and Shorts adapters: login detection, the disclosures Studio
 * requires, the soft captions fallback, Public visibility and link
 * normalization. Driven by a fake page, no Chromium.
 */
import { describe, expect, it } from 'vitest';
import { shortsAdapter, youtubeAdapter } from './youtube.js';

function fakePage({ url = 'https://studio.youtube.com/', captionsInput = false, link = null, thumbnailInput = false, published = true } = {}) {
  const log = [];
  const element = (sel, name) => {
    const el = {
      first: () => el,
      last: () => el,
      filter: (opts) => element(sel, String(opts?.hasText ?? name)),
      locator: (child) => element(`${sel} ${child}`, name),
      count: async () => {
        if (/captions-file-loader|caption i|\.srt/.test(sel)) return captionsInput ? 1 : 0;
        if (/file-loader\[accept\*=image\]/.test(sel)) return thumbnailInput ? 1 : 0;
        return 1;
      },
      isVisible: async () => false,
      waitFor: async () => {},
      click: async () => { log.push(['click', sel]); },
      setInputFiles: async (path) => { log.push(['setFiles', sel, path]); },
    };
    return el;
  };
  return {
    log,
    url: () => url,
    goto: async (to) => { log.push(['goto', to]); },
    waitForTimeout: async () => {},
    keyboard: { press: async (key) => { log.push(['press', key]); }, insertText: async (text) => { log.push(['type', text]); } },
    locator: (sel) => element(sel),
    evaluate: async (_fn, arg) => {
      if (arg === 'Music') return true;
      if (typeof arg === 'string' && arg.startsWith('(https?')) return link;
      return undefined;
    },
    waitForFunction: async () => { if (!published) throw new Error('timeout'); },
  };
}

const payload = { title: 'Song', description: 'About', video: { path: '/v/song.mp4' }, tags: ['a', 'b'] };
const clicked = (page) => page.log.filter(([kind]) => kind === 'click').map(([, sel]) => sel);

describe.each([['YouTube', youtubeAdapter], ['YouTube Shorts', shortsAdapter]])('%s adapter', (label, adapter) => {
  it('is labelled for its platform', () => {
    expect(adapter.label).toBe(label);
  });

  it('asks for sign-in when the upload page redirects to Google accounts', async () => {
    const page = fakePage({ url: 'https://accounts.google.com/signin' });
    await expect(adapter.prepare(page, payload)).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED', context: { platform: label } });
    expect(page.log.some(([kind]) => kind === 'setFiles')).toBe(false);
  });

  it('answers the not-for-kids, no-paid-promotion and altered-content radios and picks Public', async () => {
    const page = fakePage();
    await adapter.prepare(page, payload);
    const hits = clicked(page).join('\n');
    expect(hits).toContain('VIDEO_MADE_FOR_KIDS_NOT_MFK');
    expect(hits).toContain('VIDEO_PAID_PRODUCT_PLACEMENT_NO');
    expect(hits).toContain('VIDEO_HAS_ALTERED_CONTENT_YES');
    expect(hits).toContain('name=PUBLIC');
    expect(hits).not.toContain('#done-button');
    expect(page.log).toContainEqual(['setFiles', 'input[type=file][name=Filedata]', '/v/song.mp4']);
  });

  it('fails the draft when a required disclosure radio is missing', async () => {
    const page = fakePage();
    const base = page.locator;
    page.locator = (sel) => {
      const el = base(sel);
      if (/ALTERED_CONTENT/.test(sel)) el.click = async () => { throw new Error('Timeout 60000ms exceeded'); };
      return el;
    };
    await expect(adapter.prepare(page, payload)).rejects.toThrow(/disclose altered or synthetic content/);
  });

  it('leaves captions for the director when Studio shows no subtitles control', async () => {
    const summary = await adapter.prepare(fakePage(), { ...payload, captions: { path: '/v/lyrics.srt' } });
    expect(summary.captions).toBe(false);
    expect(summary.leftForYou).toEqual(['lyric captions (upload the subtitles file in Video elements)']);
  });

  it('uploads captions through the file input when it is present', async () => {
    const page = fakePage({ captionsInput: true });
    const summary = await adapter.prepare(page, { ...payload, captions: { path: '/v/lyrics.srt' } });
    expect(summary.captions).toBe(true);
    expect(summary.leftForYou).toBeUndefined();
    expect(page.log.some(([kind, , path]) => kind === 'setFiles' && path === '/v/lyrics.srt')).toBe(true);
  });

  it('adds no left-for-you notes when no captions were requested', async () => {
    const summary = await adapter.prepare(fakePage(), payload);
    expect(summary).not.toHaveProperty('leftForYou');
  });

  it('uploads a thumbnail only when the channel offers the input', async () => {
    expect((await adapter.prepare(fakePage({ thumbnailInput: true }), { ...payload, thumbnail: { path: '/v/t.png' } })).thumbnail).toBe(true);
    expect((await adapter.prepare(fakePage(), { ...payload, thumbnail: { path: '/v/t.png' } })).thumbnail).toBe(false);
  });

  it('adds a scheme to a scheme-less Shorts link and keeps a full one', async () => {
    expect((await adapter.prepare(fakePage({ link: 'youtube.com/shorts/abc_123' }), payload)).link).toBe('https://youtube.com/shorts/abc_123');
    expect((await adapter.prepare(fakePage({ link: 'https://youtu.be/abc' }), payload)).link).toBe('https://youtu.be/abc');
    expect((await adapter.prepare(fakePage({ link: null }), payload)).link).toBeNull();
  });

  it('publishes only on submit and resolves the normalized link', async () => {
    const page = fakePage({ link: 'youtube.com/shorts/xyz' });
    await expect(adapter.submit(page)).resolves.toEqual({ url: 'https://youtube.com/shorts/xyz' });
    expect(clicked(page)).toEqual(['#done-button']);
  });

  it('reports a failed publish confirmation as a step failure', async () => {
    await expect(adapter.submit(fakePage({ published: false }))).rejects.toThrow(/confirm it published/);
  });
});
