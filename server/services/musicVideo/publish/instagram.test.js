/**
 * Instagram Reels adapter: login detection, the Original 9:16 crop, caption
 * typing that never presses Escape, and the AI label toggle. Driven by a fake
 * page, no Chromium.
 */
import { describe, expect, it } from 'vitest';
import { instagramAdapter } from './instagram.js';

function fakePage({ url = 'https://www.instagram.com/', passwordField = false, aiToggle = true, nextFails = false } = {}) {
  const log = [];
  const element = (sel) => {
    const el = {
      first: () => el,
      count: async () => (/name=password/.test(sel) && passwordField ? 1 : 0),
      setInputFiles: async (path) => { log.push(['setFiles', path]); },
    };
    return el;
  };
  return {
    log,
    url: () => url,
    goto: async (to) => { log.push(['goto', to]); },
    waitForTimeout: async () => {},
    keyboard: {
      press: async (key) => { log.push(['press', key]); },
      type: async (text) => { log.push(['type', text]); },
    },
    locator: (sel) => element(sel),
    evaluate: async (fn, arg) => {
      const src = fn.toString();
      if (Array.isArray(arg)) {
        // clickVisibleText(page, text, { selector })
        log.push(['clickText', arg[1]]);
        return !(nextFails && arg[1] === 'Next');
      }
      if (typeof arg === 'string') {
        // ensureToggleBeside(page, labelText)
        log.push(['toggle', arg]);
        return aiToggle ? true : null;
      }
      if (/Original/.test(src)) log.push(['cropOriginal']);
      else if (/Select crop/.test(src)) log.push(['openCrop']);
      else if (/Advanced settings/.test(src)) log.push(['advanced']);
      else if (/Add a caption/.test(src)) log.push(['focusCaption']);
      return undefined;
    },
  };
}

const payload = { video: { path: '/v/reel.mp4' }, caption: 'A new song' };

describe('Instagram adapter', () => {
  it('asks for sign-in on the login redirect or when a password field shows', async () => {
    await expect(instagramAdapter.prepare(fakePage({ url: 'https://www.instagram.com/accounts/login/' }), payload))
      .rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
    await expect(instagramAdapter.prepare(fakePage({ passwordField: true }), payload))
      .rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
  });

  it('keeps the Original crop after opening the crop menu, before moving on', async () => {
    const page = fakePage();
    await instagramAdapter.prepare(page, payload);
    const kinds = page.log.map(([kind]) => kind);
    expect(kinds.indexOf('openCrop')).toBeGreaterThan(kinds.indexOf('setFiles'));
    expect(kinds.indexOf('cropOriginal')).toBeGreaterThan(kinds.indexOf('openCrop'));
    expect(kinds.indexOf('cropOriginal')).toBeLessThan(kinds.indexOf('focusCaption'));
  });

  it('types the caption into the focused box and never presses Escape', async () => {
    const page = fakePage();
    await instagramAdapter.prepare(page, payload);
    expect(page.log).toContainEqual(['type', 'A new song']);
    expect(page.log.filter(([kind]) => kind === 'press')).toEqual([]);
  });

  it('skips the caption step when there is no caption', async () => {
    const page = fakePage();
    await instagramAdapter.prepare(page, { ...payload, caption: '' });
    expect(page.log.some(([kind]) => kind === 'type' || kind === 'focusCaption')).toBe(false);
  });

  it('turns on the AI label under Advanced settings and reports it', async () => {
    const page = fakePage();
    const summary = await instagramAdapter.prepare(page, payload);
    expect(page.log).toContainEqual(['toggle', 'Add AI label']);
    expect(summary).toEqual({ caption: 'A new song', aiLabel: true });
    const kinds = page.log.map(([kind]) => kind);
    expect(kinds.indexOf('toggle')).toBeGreaterThan(kinds.indexOf('advanced'));
  });

  it('reports the AI label as off when the toggle is not found', async () => {
    expect((await instagramAdapter.prepare(fakePage({ aiToggle: false }), payload)).aiLabel).toBe(false);
  });

  it('names the step when Next cannot be pressed', async () => {
    await expect(instagramAdapter.prepare(fakePage({ nextFails: true }), payload)).rejects.toThrow(/Instagram: go to Edit/);
  });

  it('never shares during prepare', async () => {
    const page = fakePage();
    await instagramAdapter.prepare(page, payload);
    expect(page.log).not.toContainEqual(['clickText', 'Share']);
  });
});
