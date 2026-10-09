/**
 * LinkedIn adapter: the share box gets the video and the post text and is left
 * for the director's Post; once they open the new post, its link is recorded
 * and the first comment is typed (never sent).
 */
import { describe, expect, it, vi } from 'vitest';
import { linkedinAdapter } from './linkedin.js';

function fakePage({ url = 'https://www.linkedin.com/feed/?shareActive=true', shows = '' } = {}) {
  const log = [];
  const page = {
    log,
    goto: async (to) => { log.push(['goto', to]); },
    url: () => url,
    waitForTimeout: async () => {},
    waitForEvent: async () => ({ setFiles: async (path) => { log.push(['setFiles', path]); } }),
    waitForFunction: async (_fn, arg) => { if (typeof arg === 'string' && arg !== '[role=dialog]' && !shows.includes(arg)) throw new Error('timed out'); },
    locator: (sel) => {
      const el = {
        first: () => el,
        waitFor: async () => {},
        isVisible: async () => true,
        click: async () => { log.push(['click', sel]); },
      };
      return el;
    },
    // pasteText passes [selector, text]; clickVisibleText passes [selector, label]; the length read passes the selector.
    evaluate: async (_fn, arg) => {
      if (Array.isArray(arg)) { log.push(['paste', arg[0], arg[1]]); return true; }
      return 21;
    },
  };
  return page;
}

const payload = { video: { path: '/videos/x.mp4' }, text: 'I made a music video.\n\nMore.', firstComment: 'Full video: https://youtu.be/abc' };

describe('LinkedIn adapter', () => {
  it('uploads the video and pastes the post into the share box, pressing nothing', async () => {
    const page = fakePage();
    const summary = await linkedinAdapter.prepare(page, payload);
    expect(page.log[0]).toEqual(['goto', 'https://www.linkedin.com/feed/?shareActive=true']);
    expect(page.log).toContainEqual(['setFiles', '/videos/x.mp4']);
    expect(page.log).toContainEqual(['paste', '[role=dialog] .ql-editor[contenteditable=true]', payload.text]);
    expect(page.log.some(([kind, sel]) => kind === 'click' && /Post/.test(sel))).toBe(false);
    expect(summary).toMatchObject({ characters: 21, firstComment: expect.stringMatching(/View post/) });
  });

  it('asks for sign-in when LinkedIn redirects to its login wall', async () => {
    await expect(linkedinAdapter.prepare(fakePage({ url: 'https://www.linkedin.com/authwall?trk=x' }), payload)).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
  });

  it('records the opened post and types the first comment without sending it', async () => {
    const page = fakePage({ url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789/?trk=x', shows: 'I made a music video.' });
    await expect(linkedinAdapter.findPost(page, payload)).resolves.toBe('https://www.linkedin.com/feed/update/urn:li:activity:7123456789/');
    expect(page.log.filter(([kind]) => kind === 'paste').map(([, , text]) => text)).toEqual([payload.firstComment]);
    expect(page.log.filter(([kind]) => kind === 'click').every(([, sel]) => /comment/.test(sel))).toBe(true);
  });

  it('ignores the feed and other posts', async () => {
    await expect(linkedinAdapter.findPost(fakePage({ url: 'https://www.linkedin.com/feed/' }), payload)).resolves.toBeNull();
    const other = fakePage({ url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/', shows: 'Someone else' });
    await expect(linkedinAdapter.findPost(other, payload)).resolves.toBeNull();
    expect(other.log).toEqual([]);
  });

  it('still records the post when the comment box cannot be found', async () => {
    const page = fakePage({ url: 'https://www.linkedin.com/feed/update/urn:li:activity:7/', shows: 'I made a music video.' });
    page.locator = () => ({ first() { return this; }, click: async () => { throw new Error('no comment box'); } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(linkedinAdapter.findPost(page, payload)).resolves.toBe('https://www.linkedin.com/feed/update/urn:li:activity:7/');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
