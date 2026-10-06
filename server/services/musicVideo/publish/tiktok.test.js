import { describe, it, expect } from 'vitest';
import { tiktokAdapter } from './tiktok.js';

const OVERLAY = '.react-joyride__overlay';

// TikTok Studio's upload page with `tourSteps` onboarding tooltips over the
// form. `buttons` are the tooltip's own buttons (each press closes one step),
// `escape` says whether Escape closes a step, and `late` mounts the tour only
// once the adapter waits for it. The overlay swallows clicks while it is up.
const fakePage = ({ tourSteps = 0, buttons = ['Got it'], escape = false, late = false } = {}) => {
  let tour = late ? 0 : tourSteps;
  let pending = late ? tourSteps : 0;
  const calls = { editorClicked: false, editorClickedUnderTour: false, pressed: [], escapes: 0, buttonSelectors: new Set() };
  const page = {
    calls,
    goto: async () => {},
    url: () => 'https://www.tiktok.com/tiktokstudio/upload',
    waitForTimeout: async () => {},
    keyboard: {
      press: async (k) => {
        if (k !== 'Escape') return;
        calls.escapes += 1;
        if (tour && escape) tour -= 1;
      },
    },
    evaluate: async (_fn, arg) => {
      if (Array.isArray(arg) && (arg[1] === 'Got it' || arg[1] === 'Skip')) {
        calls.buttonSelectors.add(arg[0]);
        if (!tour || !buttons.includes(arg[1])) return false;
        calls.pressed.push(arg[1]);
        tour -= 1;
        return true;
      }
      return true;
    },
    locator: (sel) => {
      const node = {
        count: async () => (sel === OVERLAY ? (tour ? 1 : 0) : 1),
        waitFor: async () => {
          if (sel !== OVERLAY) return;
          if (pending) { tour = pending; pending = 0; }
          if (!tour) throw new Error('timeout');
        },
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
const run = (page) => expect(tiktokAdapter.prepare(page, payload)).rejects.toThrow(/stop here/);

describe('TikTok Studio tour', () => {
  it('presses Got it on every tooltip step before writing the caption', async () => {
    const page = fakePage({ tourSteps: 2 });
    await run(page);
    expect(page.calls.pressed).toEqual(['Got it', 'Got it']);
    expect(page.calls.editorClicked).toBe(true);
    expect(page.calls.editorClickedUnderTour).toBe(false);
  });

  it('waits for a tour that mounts after the caption editor appears', async () => {
    const page = fakePage({ tourSteps: 1, late: true });
    await run(page);
    expect(page.calls.pressed).toEqual(['Got it']);
    expect(page.calls.editorClickedUnderTour).toBe(false);
  });

  it('presses Skip when the step has no Got it', async () => {
    const page = fakePage({ tourSteps: 1, buttons: ['Skip'] });
    await run(page);
    expect(page.calls.pressed).toEqual(['Skip']);
    expect(page.calls.editorClickedUnderTour).toBe(false);
  });

  it('falls back to Escape when the tooltip has neither button', async () => {
    const page = fakePage({ tourSteps: 1, buttons: [], escape: true });
    await run(page);
    expect(page.calls.pressed).toEqual([]);
    expect(page.calls.escapes).toBe(2); // the tour's, then the hashtag popup's after the caption
    expect(page.calls.editorClickedUnderTour).toBe(false);
  });

  it("only presses the tooltip's own buttons", async () => {
    const page = fakePage({ tourSteps: 1, buttons: [], escape: true });
    await run(page);
    expect([...page.calls.buttonSelectors]).toEqual(['.__floater button, .react-joyride__tooltip button']);
  });

  it('goes straight on when there is no tour', async () => {
    const page = fakePage();
    await run(page);
    expect(page.calls.pressed).toEqual([]);
    expect(page.calls.escapes).toBe(1); // only the hashtag-popup Escape after the caption
  });

  it('names the tooltip instead of timing out on the caption when it will not close', async () => {
    const page = fakePage({ tourSteps: 1, buttons: [], escape: false });
    await expect(tiktokAdapter.prepare(page, payload)).rejects.toThrow(/close the Studio tour.*onboarding tooltip/);
    expect(page.calls.escapes).toBe(5);
    expect(page.calls.editorClicked).toBe(false);
  });
});
