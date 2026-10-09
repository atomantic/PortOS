import { describe, it, expect, afterEach } from 'vitest';
import { sunoHookAdapter } from './sunoHook.js';
import { pickSongRow } from '../../../lib/sunoSongPicker.js';
import { buildPublishPayload } from './payloads.js';
import { captureMusicVideoEvidence } from '../../../lib/musicVideoDependencies.js';

const ID = '12345678-abcd-4abc-8abc-123456789abc';
const project = (extra = {}) => {
  const base = {
    name: 'Night Drive', scenes: [], renderHistoryId: 'r1', audioAnalysis: { durationSec: 187 },
    publishKit: { links: { song: `https://suno.com/song/${ID}` }, copy: { tiktok: { caption: 'Hook caption' } } },
  };
  const excerpts = [{ id: 'e1', status: 'complete', aspect: '9:16', filename: 'cut.mp4', startSec: 42, endSec: 62, dependencies: captureMusicVideoEvidence(base, { startSec: 42, endSec: 62 }) }];
  return { ...base, excerpts, ...extra };
};

describe('Suno Hook payload', () => {
  it('sets the window to the cut start and keeps the song id, title, length and caption', () => {
    const p = buildPublishPayload('sunoHook', project());
    expect(p).toMatchObject({ songId: ID, title: 'Night Drive', durationSec: 187, startSec: 42, caption: 'Hook caption', showLyrics: false, video: { dir: 'videos', name: 'cut.mp4' } });
  });
  it('says whether the cut it posts is native 9:16 or the fitted master', () => {
    expect(buildPublishPayload('sunoHook', project()).cutLayout).toBe('native');
    const fitted = project({ excerpts: [], renderHistoryId: 'r1', publishKit: {
      ...project().publishKit, master: { renderHistoryId: 'r1' },
      exports: [{ kind: 'vertical-9x16', filename: 'kit.mp4', startSec: 20, endSec: 50, layout: 'fit', fitReason: 'unavailable' }],
    } });
    expect(buildPublishPayload('sunoHook', fitted)).toMatchObject({ startSec: 20, cutLayout: 'fit', video: { name: 'kit.mp4' } });
  });
  it('refuses a missing song URL and a project with no vertical cut', () => {
    expect(() => buildPublishPayload('sunoHook', project({ publishKit: {} }))).toThrow(/Suno song URL/);
    expect(() => buildPublishPayload('sunoHook', project({ excerpts: [] }))).toThrow(/9:16/);
  });
});

describe('pickSongRow', () => {
  const row = (text, html = '') => ({ text, html });
  it('prefers an id match, then the same length, and refuses an ambiguous pick', () => {
    const rows = [row('Night Drive 2:10 synthwave'), row('Night Drive 3:07 synthwave', `<a href="/song/${ID}">`)];
    expect(pickSongRow(rows, { songId: ID, title: 'Night Drive', durationSec: 130 })).toBe(1);
    const noIds = [row('Night Drive 2:10'), row('Night Drive 3:07')];
    expect(pickSongRow(noIds, { songId: ID, title: 'Night Drive', durationSec: 187 })).toBe(1);
    expect(pickSongRow(noIds, { songId: ID, title: 'Night Drive', durationSec: null })).toBe(-1);
    expect(pickSongRow([row('Night Drive 2:10')], { songId: ID, title: 'Night Drive' })).toBe(0);
  });
});

// The Create Hook page as the adapter sees it (#10860): the player clock ("0:00 / 0:26") beside the
// window pill, a window that opens at Suno's own suggestion, and a waveform where 22.2 px of drag
// moves the window one second (dragging right moves it earlier). `stuckAt` stops the window there.
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const PILL = 'pointer-events-none rounded-full border-2 px-2 pt-1 pb-1.5 font-mono text-xs';
function hookPage({ windowAt = 158, pxPerSec = 22.2, stuckAt = null, restored = false } = {}) {
  const state = { windowAt, clicked: [], drags: 0 };
  const leaf = (text, cls, parentText = text) => ({ children: [], textContent: text, className: cls, offsetParent: {}, parentElement: { textContent: parentText } });
  const dom = {
    'span,div': () => [
      leaf('0:00', 'text-foreground-primary', '0:00 / 0:26'),
      leaf(fmt(state.windowAt), PILL),
      leaf('3:42', 'text-xs'), leaf('3:42', 'text-xs'),
    ],
    '[role=dialog] button': () => [{ innerText: 'Use', innerHTML: '', parentElement: { querySelectorAll: () => [1, 2, 3] } }],
    'button,[role=button]': () => [{ offsetParent: {}, innerText: 'Next', click: () => state.clicked.push('Next') }],
    'span,div,label': () => [{ children: [], textContent: 'Show Lyrics', parentElement: { querySelector: () => ({ getAttribute: () => 'true', click: () => state.clicked.push('Show Lyrics') }) } }],
  };
  const visibleSongButton = restored ? 'Replace Song' : 'Select Song';
  const locator = (sel, hasText) => ({
    first: () => locator(sel, hasText),
    nth: () => locator(sel, hasText),
    filter: (o) => locator(sel, o.hasText),
    count: async () => 1,
    waitFor: async () => {},
    fill: async () => {},
    setInputFiles: async () => {},
    boundingBox: async () => ({ x: 100, y: 400, width: 600, height: 80 }),
    click: async () => {
      if (sel === 'text=Select Song' && restored) throw new Error('element is not visible');
      if (sel === 'button:visible' && !hasText.test(visibleSongButton)) throw new Error('no visible song button');
      state.clicked.push(sel === 'button:visible' ? visibleSongButton : sel);
    },
  });
  let downX = null;
  const page = {
    state,
    goto: async () => {},
    url: () => 'https://suno.com/hooks/create',
    waitForTimeout: async () => {},
    locator: (sel) => locator(sel),
    evaluate: async (fn, arg) => {
      globalThis.document = { querySelectorAll: (sel) => dom[(Array.isArray(arg) && arg[0]) || sel]?.() ?? [] };
      return fn(arg);
    },
    mouse: {
      move: async (x) => { page.lastX = x; },
      down: async () => { downX = page.lastX ?? 400; },
      up: async () => {
        state.drags += 1;
        const moved = ((page.lastX ?? downX) - downX) / pxPerSec;
        let next = Math.max(0, state.windowAt - moved);
        if (stuckAt != null && next < stuckAt) next = stuckAt;
        state.windowAt = next;
        downX = null;
      },
    },
  };
  return page;
}

const hookPayload = (over = {}) => ({ video: { path: '/tmp/cut.mp4' }, songId: ID, title: 'Night Drive', durationSec: 222, startSec: 20, caption: 'Hook caption', showLyrics: false, cutLayout: 'native', ...over });

describe('Suno Hook fill (#10860)', () => {
  afterEach(() => { delete globalThis.document; });

  it('moves a window Suno opened at 2:38 to 0:20, reading the pill rather than the player clock', async () => {
    const page = hookPage({ windowAt: 158 });
    const summary = await sunoHookAdapter.prepare(page, hookPayload());
    expect(Math.abs(summary.windowStart - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(page.state.windowAt - 20)).toBeLessThanOrEqual(1);
    expect(page.state.drags).toBeGreaterThan(1); // the waveform is narrower than 138 s of drag
    expect(page.state.clicked).not.toContain('Post');
    expect(summary).not.toHaveProperty('cut');
  });

  it('recalibrates when the page drags at another rate, and moves a window that opened early later', async () => {
    const page = hookPage({ windowAt: 5, pxPerSec: 40 });
    const summary = await sunoHookAdapter.prepare(page, hookPayload({ startSec: 95 }));
    expect(Math.abs(summary.windowStart - 95)).toBeLessThanOrEqual(1);
  });

  it('fails clearly when it cannot get the window within a second', async () => {
    const page = hookPage({ windowAt: 158, stuckAt: 60 });
    await expect(sunoHookAdapter.prepare(page, hookPayload())).rejects.toThrow('Suno Hook: set the audio window (the window reads 1:00, wanted 0:20)');
  });

  it('picks the song through the visible Replace Song button of a restored draft, and says a fitted cut is fitted', async () => {
    const page = hookPage({ windowAt: 158, restored: true });
    const summary = await sunoHookAdapter.prepare(page, hookPayload({ cutLayout: 'fit' }));
    expect(page.state.clicked).toContain('Replace Song');
    expect(summary).toMatchObject({ caption: 'Hook caption', showLyrics: false, cut: expect.stringMatching(/Fitted/) });
  });
});
