import { describe, it, expect } from 'vitest';
import { tiktokAdapter } from './tiktok.js';

// TikTok Studio's upload page with `tourSteps` onboarding tooltips over the
// form. Each "Got it" closes one; the overlay swallows clicks while it is up.
const fakePage = ({ tourSteps = 0, closes = true } = {}) => {
  let tour = tourSteps;
  const calls = { editorClickedUnderTour: false, editorClicked: false, escapes: 0 };
  const page = {
    calls,
    goto: async () => {},
    url: () => 'https://www.tiktok.com/tiktokstudio/upload',
    waitForTimeout: async () => {},
    keyboard: { press: async (k) => { if (k === 'Escape') calls.escapes += 1; } },
    evaluate: async (_fn, arg) => {
      if (Array.isArray(arg) && arg[1] === 'Got it') { if (!tour) return false; if (closes) tour -= 1; return true; }
      if (Array.isArray(arg) && arg[1] === 'Skip') return false;
      return true;
    },
    locator: (sel) => {
      const node = {
        count: async () => (sel === '.react-joyride__overlay' ? (tour ? 1 : 0) : 1),
        waitFor: async () => {},
        setInputFiles: async () => {},
        click: async () => {
          if (sel === '[contenteditable=true]') { calls.editorClicked = true; if (tour) calls.editorClickedUnderTour = true; }
          if (sel === 'text=Show more') throw new Error('stop here');
        },
        first: () => node,
      };
      return node;
    },
  };
  return page;
};

const payload = { video: { path: '/tmp/v.mp4' }, caption: 'hello' };

describe('TikTok Studio tour', () => {
  it('closes every onboarding tooltip before writing the caption', async () => {
    const page = fakePage({ tourSteps: 2 });
    await expect(tiktokAdapter.prepare(page, payload)).rejects.toThrow(/stop here/);
    expect(page.calls.editorClicked).toBe(true);
    expect(page.calls.editorClickedUnderTour).toBe(false);
  });

  it('goes straight on when there is no tour', async () => {
    const page = fakePage();
    await expect(tiktokAdapter.prepare(page, payload)).rejects.toThrow(/stop here/);
    expect(page.calls.escapes).toBeGreaterThanOrEqual(1); // only the hashtag-popup Escape after the caption
  });

  it('names the tooltip instead of timing out on the caption when it will not close', async () => {
    const page = fakePage({ tourSteps: 1, closes: false });
    await expect(tiktokAdapter.prepare(page, payload)).rejects.toThrow(/close the Studio tour.*onboarding tooltip/);
    expect(page.calls.editorClicked).toBe(false);
  });
});
