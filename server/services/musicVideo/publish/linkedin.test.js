/**
 * LinkedIn adapter: the share box (drawn in a shadow root, so reached only
 * through locators) gets the video and the post text and is left for the
 * director's Post; once they open the new post, its link is recorded and the
 * first comment is typed (never sent).
 */
import { describe, expect, it, vi } from 'vitest';
import { linkedinAdapter } from './linkedin.js';

const EDITOR = '[role=dialog] .ql-editor[contenteditable=true]';

// A page whose elements exist only for locators. Like LinkedIn, attaching the
// video swaps the composer for the media editor until its Next is pressed.
function fakePage({ url = 'https://www.linkedin.com/feed/?shareActive=true', shows = '', pasteWorks = true } = {}) {
  const log = [];
  let composer = true;
  const typed = {};
  const page = {
    log,
    goto: async (to) => { log.push(['goto', to]); },
    url: () => url,
    waitForTimeout: async () => {},
    waitForEvent: async () => ({ setFiles: async (path) => { log.push(['setFiles', path]); composer = false; } }),
    keyboard: {
      press: async (key) => { log.push(['press', key]); },
      insertText: async (text) => { log.push(['insert', text]); },
    },
    getByText: (want) => ({ first: () => ({ waitFor: async () => { if (!shows.includes(want)) throw new Error('timeout'); } }) }),
    locator: (sel, opts) => {
      const name = opts?.hasText?.source?.replace(/\^\\s\*|\\s\*\$/g, '');
      const isEditor = sel === EDITOR || sel.includes('comments-');
      const el = {
        first: () => el,
        last: () => el,
        filter: () => ({ count: async () => 0 }),
        count: async () => (/progressbar/.test(sel) ? 0 : 1),
        isEnabled: async () => true,
        waitFor: async () => { if (sel === EDITOR && !composer) throw new Error('timeout'); },
        isVisible: async () => (sel === EDITOR ? composer : true),
        click: async () => {
          if (sel === EDITOR && !composer) throw new Error('not attached');
          log.push(['click', name || sel]);
          if (name === 'Next') composer = true;
        },
        evaluate: async (_fn, text) => { if (pasteWorks) typed[sel] = text; log.push(['paste', sel, text]); },
        innerText: async () => (isEditor ? typed[sel] || '' : ''),
      };
      return el;
    },
  };
  return page;
}

const payload = { video: { path: '/videos/x.mp4' }, text: 'I made a music video.\n\nMore.', firstComment: 'Full video: https://youtu.be/abc' };

describe('LinkedIn adapter', () => {
  it('uploads the video, presses the media editor\'s Next, and pastes the post, never pressing Post', async () => {
    const page = fakePage();
    const summary = await linkedinAdapter.prepare(page, payload);
    expect(page.log[0]).toEqual(['goto', 'https://www.linkedin.com/feed/?shareActive=true']);
    expect(page.log).toContainEqual(['setFiles', '/videos/x.mp4']);
    expect(page.log).toContainEqual(['click', 'Next']);
    expect(page.log).toContainEqual(['paste', EDITOR, payload.text]);
    expect(page.log.some(([kind, what]) => kind === 'click' && what === 'Post')).toBe(false);
    expect(summary).toMatchObject({ characters: payload.text.length, firstComment: expect.stringMatching(/View post/) });
  });

  it('types the lines when Quill ignores the synthetic paste', async () => {
    const page = fakePage({ pasteWorks: false });
    await linkedinAdapter.prepare(page, payload);
    expect(page.log.filter(([kind]) => kind === 'insert' || kind === 'press')).toEqual([
      ['insert', 'I made a music video.'], ['press', 'Enter'], ['press', 'Enter'], ['insert', 'More.'],
    ]);
  });

  it('asks for sign-in when LinkedIn redirects to its login wall', async () => {
    await expect(linkedinAdapter.prepare(fakePage({ url: 'https://www.linkedin.com/authwall?trk=x' }), payload)).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
  });

  it('records the opened post and types the first comment once, without sending it', async () => {
    const page = fakePage({ url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789/?trk=x', shows: 'I made a music video.' });
    const draft = { ...payload };
    await expect(linkedinAdapter.findPost(page, draft)).resolves.toBe('https://www.linkedin.com/feed/update/urn:li:activity:7123456789/');
    expect(page.log.filter(([kind]) => kind === 'paste').map(([, , text]) => text)).toEqual([payload.firstComment]);
    expect(page.log.filter(([kind]) => kind === 'click').every(([, sel]) => /comment/.test(sel))).toBe(true);
    // A reload of the post page records it again but never types the comment twice.
    await linkedinAdapter.findPost(page, draft);
    expect(page.log.filter(([kind]) => kind === 'paste')).toHaveLength(1);
  });

  it('ignores the feed and other posts', async () => {
    await expect(linkedinAdapter.findPost(fakePage({ url: 'https://www.linkedin.com/feed/' }), payload)).resolves.toBeNull();
    const other = fakePage({ url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/', shows: 'Someone else' });
    await expect(linkedinAdapter.findPost(other, payload)).resolves.toBeNull();
    expect(other.log).toEqual([]);
  });

  it('still records the post when the comment box cannot be found', async () => {
    const page = fakePage({ url: 'https://www.linkedin.com/feed/update/urn:li:activity:7/', shows: 'I made a music video.' });
    const base = page.locator;
    page.locator = (sel, opts) => (sel.includes('comments-') ? { first() { return this; }, click: async () => { throw new Error('no comment box'); } } : base(sel, opts));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(linkedinAdapter.findPost(page, { ...payload })).resolves.toBe('https://www.linkedin.com/feed/update/urn:li:activity:7/');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
