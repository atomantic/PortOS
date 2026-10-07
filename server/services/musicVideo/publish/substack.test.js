/**
 * Substack adapter order: the video URL is pasted alone (so Substack can turn
 * it into an embed), then the body goes after it without clicking the
 * editor, whose middle is the embed by then.
 */
import { describe, expect, it } from 'vitest';
import { substackAdapter } from './substack.js';

function fakePage({ embedded = true, url = 'https://example.substack.com/publish/post' } = {}) {
  const log = [];
  const element = (sel) => ({
    first: () => element(sel),
    waitFor: async () => {},
    fill: async (value) => { log.push(['fill', sel, value]); },
    click: async () => { log.push(['click', sel]); },
  });
  const page = {
    log,
    goto: async (to) => { log.push(['goto', to]); },
    url: () => url,
    waitForTimeout: async () => {},
    locator: (sel) => element(sel),
    keyboard: { press: async (key) => { log.push(['press', key]); } },
    // pasteText passes [selector, text]; focus and the embed check pass the selector alone.
    evaluate: async (_fn, arg) => {
      if (Array.isArray(arg)) { log.push(['paste', arg[1]]); return true; }
      log.push(['evaluate']);
      return embedded;
    },
  };
  return page;
}

const payload = { publication: 'example.substack.com', title: 'Example Song', subtitle: 'A line', body: 'Para one\n\nPara two', videoUrl: 'https://youtu.be/abc' };

describe('Substack adapter', () => {
  it('pastes the video alone, then writes the body at the end without clicking the embed', async () => {
    const page = fakePage();
    const summary = await substackAdapter.prepare(page, payload);
    expect(page.log[0]).toEqual(['goto', 'https://example.substack.com/publish/post?type=newsletter']);
    const pastes = page.log.filter(([kind]) => kind === 'paste').map(([, text]) => text);
    expect(pastes).toEqual(['https://youtu.be/abc', 'Para one\n\nPara two']);
    const afterVideo = page.log.slice(page.log.findIndex(([kind, text]) => kind === 'paste' && text === payload.videoUrl) + 1);
    expect(afterVideo.some(([kind]) => kind === 'click')).toBe(false);
    expect(afterVideo.filter(([kind]) => kind === 'press').map(([, key]) => key)).toEqual(['ControlOrMeta+End', 'Enter']);
    expect(summary).toMatchObject({ publication: 'example.substack.com', title: 'Example Song', video: 'Embedded: https://youtu.be/abc' });
  });

  it('says when the link stayed plain text, and asks for sign-in when Substack redirects', async () => {
    await expect(substackAdapter.prepare(fakePage({ embedded: false }), payload)).resolves.toMatchObject({ video: 'Link (not embedded): https://youtu.be/abc' });
    await expect(substackAdapter.prepare(fakePage({ url: 'https://substack.com/sign-in?redirect=x' }), payload)).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
  });
});
