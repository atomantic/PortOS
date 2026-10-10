/**
 * Facebook adapter: the composer gets the post text and the video and is left
 * for the director's Post; once they open the new post, its link is recorded
 * and the first comment is typed (never sent).
 */
import { describe, expect, it, vi } from 'vitest';
import { facebookAdapter } from './facebook.js';

// A page whose elements exist only for locators, logging every click, paste and
// file. Like Facebook's composer (2026), the drop zone's file input is there
// from the start, the upload ends in an "Uploaded media" section with Remove
// video, and the AI label row holds an unnamed switch.
function fakePage({ url = 'https://www.facebook.com/', shows = '', signedOut = false, nextButton = false, inputPresent = true, aiRow = true } = {}) {
  const log = [];
  const typed = {};
  let uploaded = false;
  let photoVideoOpened = false;
  let aiOn = false;
  const element = (sel, name) => {
    const el = {
      first: () => el,
      last: () => el,
      filter: (opts) => element(sel, opts?.hasText?.source || name),
      locator: (child, opts) => element(`${sel} ${child}`, opts?.hasText?.source || name),
      getByRole: (_role, opts) => element(`${sel} button`, opts.name),
      count: async () => {
        if (/input\[name=pass\]/.test(sel)) return signedOut ? 1 : 0;
        if (/progressbar/.test(sel)) return 0;
        if (/Uploaded media/.test(String(name)) || name === 'Remove video') return uploaded ? 1 : 0;
        if (/AI label/.test(String(name))) return aiRow ? 1 : 0;
        if (name === 'Next') return nextButton ? 1 : 0;
        return /Uploading/.test(String(name)) ? 0 : 1;
      },
      waitFor: async () => { if (/input\[type=file\]/.test(sel) && !inputPresent && !photoVideoOpened) throw new Error('timeout'); },
      getAttribute: async () => String(aiOn),
      click: async () => {
        log.push(['click', name || sel]);
        if (name === 'Photo/video') photoVideoOpened = true;
        if (/AI label/.test(String(name))) aiOn = true;
      },
      setInputFiles: async (path) => { log.push(['setFiles', path]); uploaded = true; },
      evaluate: async (_fn, text) => { typed[sel] = text; log.push(['paste', sel, text]); },
      innerText: async () => typed[sel] || '',
    };
    return el;
  };
  return {
    log,
    goto: async (to) => { log.push(['goto', to]); },
    url: () => url,
    waitForTimeout: async () => {},
    keyboard: { press: async () => {}, insertText: async () => {} },
    getByText: (want) => ({ first: () => ({ waitFor: async () => { if (!shows.includes(want)) throw new Error('timeout'); } }) }),
    locator: (sel, opts) => element(sel, opts?.hasText?.source),
  };
}

const payload = { video: { path: '/videos/x.mp4' }, text: 'I made a music video.\n\nMore.', firstComment: 'Full video: https://youtu.be/abc' };

describe('Facebook adapter', () => {
  it('writes the post, hands the video to the drop zone and turns on the AI label, never pressing Next or Post', async () => {
    const page = fakePage({ nextButton: true });
    const summary = await facebookAdapter.prepare(page, { ...payload, aiLabel: true });
    expect(page.log[0]).toEqual(['goto', 'https://www.facebook.com/']);
    expect(page.log).toContainEqual(['click', 'on your mind']);
    expect(page.log).toContainEqual(['setFiles', '/videos/x.mp4']);
    expect(page.log.some(([, what]) => what === 'Photo/video')).toBe(false);
    expect(page.log.find(([kind]) => kind === 'paste')[2]).toBe(payload.text);
    expect(page.log.some(([kind, what]) => kind === 'click' && /^(Post|Next)$/.test(what))).toBe(false);
    expect(summary).toMatchObject({ characters: payload.text.length, aiLabel: 'On', youPress: 'Next, then Post', firstComment: expect.stringMatching(/open the post/) });
  });

  it('opens Photo/video when the composer has no file input yet, and leaves a missing AI label to the director', async () => {
    const page = fakePage({ inputPresent: false, aiRow: false });
    const summary = await facebookAdapter.prepare(page, { ...payload, aiLabel: true });
    expect(page.log).toContainEqual(['click', 'Photo/video']);
    expect(page.log).toContainEqual(['setFiles', '/videos/x.mp4']);
    expect(summary.aiLabel).toMatch(/yourself/);
    const off = fakePage();
    expect((await facebookAdapter.prepare(off, { ...payload, aiLabel: false })).aiLabel).toMatch(/Off/);
    expect(off.log.some(([, what]) => /AI label/.test(what))).toBe(false);
  });

  it('asks for sign-in when Facebook shows its login form', async () => {
    await expect(facebookAdapter.prepare(fakePage({ signedOut: true }), payload)).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
  });

  it('records the opened reel and types the first comment once, without sending it', async () => {
    const page = fakePage({ url: 'https://www.facebook.com/reel/1234567890?s=x', shows: 'I made a music video.' });
    const draft = { ...payload };
    await expect(facebookAdapter.findPost(page, draft)).resolves.toBe('https://www.facebook.com/reel/1234567890');
    expect(page.log.filter(([kind]) => kind === 'paste').map(([, sel, text]) => [/comment/.test(sel), text])).toEqual([[true, payload.firstComment]]);
    // A reload of the post page records it again but never types the comment twice.
    await facebookAdapter.findPost(page, draft);
    expect(page.log.filter(([kind]) => kind === 'paste')).toHaveLength(1);
  });

  it('ignores the feed and other people\'s posts', async () => {
    await expect(facebookAdapter.findPost(fakePage({ url: 'https://www.facebook.com/' }), payload)).resolves.toBeNull();
    const other = fakePage({ url: 'https://www.facebook.com/someone/posts/pfbid0abc', shows: 'Someone else' });
    await expect(facebookAdapter.findPost(other, payload)).resolves.toBeNull();
    expect(other.log).toEqual([]);
  });

  it('still records the post when the comment box cannot be found', async () => {
    const page = fakePage({ url: 'https://www.facebook.com/example/videos/42', shows: 'I made a music video.' });
    const base = page.locator;
    page.locator = (sel, opts) => (/comment/.test(sel) ? { first() { return this; }, click: async () => { throw new Error('no comment box'); } } : base(sel, opts));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(facebookAdapter.findPost(page, { ...payload })).resolves.toBe('https://www.facebook.com/example/videos/42');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
