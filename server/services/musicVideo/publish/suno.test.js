import { describe, it, expect } from 'vitest';
import { sunoAdapter } from './suno.js';
import { markSunoSongMenu } from '../../../lib/sunoPage.js';

const SONG = '12345678-abcd-4abc-8abc-123456789abc';
const LANDED = '87654321-dcba-4cba-8cba-cba987654321';

// A song page: `marks` is what markSunoSongMenu finds; the Publish dialog
// opens on the marked button's click and the run stops there.
const fakePage = ({ url = `https://suno.com/song/${SONG}`, marks = true } = {}) => {
  const calls = { marked: [], clicked: [] };
  return {
    calls,
    goto: async () => {},
    url: () => url,
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      if (fn === markSunoSongMenu) { calls.marked.push(arg); return marks; }
      return true;
    },
    locator: (sel) => {
      const node = {
        count: async () => 1,
        click: async () => { calls.clicked.push(sel); },
        waitFor: async () => { throw new Error('stop here'); },
        filter: () => node,
        first: () => node,
      };
      return node;
    },
  };
};

describe('Suno prepare', () => {
  it("opens the menu marked as the page song's own", async () => {
    const page = fakePage();
    await expect(sunoAdapter.prepare(page, { songUrl: `https://suno.com/song/${SONG}` })).rejects.toThrow(/stop here/);
    expect(page.calls.marked).toEqual([SONG]);
    expect(page.calls.clicked[0]).toBe('[data-portos-song-menu]');
  });

  it('uses the song the page landed on when the link redirected', async () => {
    const page = fakePage({ url: `https://suno.com/song/${LANDED}?sh=abc` });
    await expect(sunoAdapter.prepare(page, { songUrl: `https://suno.com/song/${SONG}` })).rejects.toThrow(/stop here/);
    expect(page.calls.marked).toEqual([LANDED]);
  });

  it("fails before clicking anything when only other songs' menus are on the page", async () => {
    const page = fakePage({ marks: false });
    await expect(sunoAdapter.prepare(page, { songUrl: `https://suno.com/song/${SONG}` })).rejects.toThrow(/no menu could be tied to this page's own song/);
    expect(page.calls.clicked).toEqual([]);
  });

  it('names the URL when neither it nor the page carries a song id', async () => {
    const page = fakePage({ url: 'https://suno.com/s/abc' });
    await expect(sunoAdapter.prepare(page, { songUrl: 'https://suno.com/s/abc' })).rejects.toThrow(/no song id in https:\/\/suno\.com\/s\/abc/);
    expect(page.calls.clicked).toEqual([]);
  });
});
