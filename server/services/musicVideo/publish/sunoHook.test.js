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
  const fitted = (duration, startSec) => project({ audioAnalysis: { durationSec: duration }, excerpts: [], publishKit: {
    ...project().publishKit, master: { renderHistoryId: 'r1' },
    exports: [{ kind: 'vertical-9x16', filename: 'window.mp4', startSec, endSec: startSec + 20, layout: 'fit' }],
  } });
  it('uses the actual fractional duration and restricts shorter songs to zero', () => {
    expect(buildPublishPayload('sunoHook', fitted(258.75, 198.75)).startSec).toBe(198.75);
    expect(() => buildPublishPayload('sunoHook', fitted(258.75, 198.76))).toThrow(/earlier 9:16 cut/);
    expect(buildPublishPayload('sunoHook', fitted(40, 0))).toMatchObject({ durationSec: 40, startSec: 0 });
    expect(() => buildPublishPayload('sunoHook', fitted(40, 1))).toThrow(/earlier 9:16 cut/);
    expect(() => buildPublishPayload('sunoHook', fitted(null, 0))).toThrow(/Analyze the song audio/);
  });
  it('rejects a late default cut but keeps an explicitly selected earlier video and audio together', () => {
    const p = project();
    p.excerpts.push({ id: 'late', status: 'complete', aspect: '9:16', filename: 'late.mp4', startSec: 150, endSec: 170,
      dependencies: captureMusicVideoEvidence(p, { startSec: 150, endSec: 170 }) });
    expect(() => buildPublishPayload('sunoHook', p)).toThrow(/latest Suno Hook window start 2:07/);
    expect(buildPublishPayload('sunoHook', p, { cutId: 'e1' })).toMatchObject({ startSec: 42, video: { name: 'cut.mp4' } });
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
    expect(pickSongRow([row('Night Drive 3:07')], { songId: ID, title: 'Night Drive', durationSec: null })).toBe(0);
  });
  it('requires an exact title and uses length to disambiguate exact-title rows', () => {
    expect(pickSongRow([row('Another Song 3:07')], { title: 'Night Drive', durationSec: 187 })).toBe(-1);
    expect(pickSongRow([row('Night Drive (Remix) 3:07')], { title: 'Night Drive', durationSec: 187 })).toBe(-1);
    expect(pickSongRow([row('Night Drive 13:07')], { title: 'Night Drive', durationSec: 187 })).toBe(-1);
    expect(pickSongRow([row('Night Drive 3:07 • synthwave')], { title: 'Night Drive', durationSec: 187 })).toBe(0);
    expect(pickSongRow([row('  NIGHT   DRIVE... 3:07')], { title: 'Night Drive', durationSec: 187 })).toBe(0);
    expect(pickSongRow([row('Use Me 3:07')], { title: 'Use Me', durationSec: 187 })).toBe(0);
    expect(pickSongRow([row('Night Drive 2:10'), row('Night Drive 3:07')], { title: 'Night Drive', durationSec: 187 })).toBe(1);
  });
});

// The Create Hook page as the adapter sees it (#10860): the player clock ("0:00 / 0:26") beside the
// window pill, a window that opens at Suno's own suggestion, and a waveform where 22.2 px of drag
// moves the window one second (dragging right moves it earlier). `stuckAt` stops the window there.
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
function hookPage({ windowAt = 158, pxPerSec = 22.2, stuckAt = null, restored = false, delayedSongResults = false, failedSearch = false, searchStatus = 200, appliedAfterPoll = 1, ambiguousReadout = false, noWindowReadout = false, waveformKind = 'identified', ambiguousWaveform = false } = {}) {
  const state = { windowAt, clicked: [], drags: 0, lyrics: true, songRows: [{ text: 'Night Drive 3:42', html: '' }], songPolls: 0 };
  const rect = (bottom) => ({ left: 100, right: 200, bottom });
  const leaf = (text, bottom, parentText = text) => ({ children: [], textContent: text,
    getClientRects: () => [rect(bottom)], getBoundingClientRect: () => rect(bottom),
    parentElement: { textContent: parentText, querySelector: () => null } });
  const waveform = { getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 100, right: 700, top: 400, width: 600, height: 80 }),
    getAttribute: (name) => name === 'aria-label' ? 'Audio window' : null, contains: () => false, setAttribute: () => {}, removeAttribute: () => {} };

  const dom = {
    'body *': () => [
      leaf('0:00', 399, '0:00 / 0:26'),
      ...(noWindowReadout ? [] : [leaf(fmt(state.windowAt), 390)]),
      leaf('3:42', ambiguousReadout ? 390 : 250), leaf('3:42', 500),
    ],
    '[data-testid*="waveform" i]': () => waveformKind === 'identified' ? [waveform] : [],
    '[class*=waveform]': () => waveformKind === 'legacy' ? [waveform] : [],
    '[role="slider"]': () => waveformKind === 'slider' ? [waveform] : [],
    canvas: () => waveformKind === 'canvas' ? (ambiguousWaveform ? [waveform, { ...waveform }] : [waveform]) : [],
    '[role=dialog] button': () => state.songRows.map(({ text, html }) => ({ innerText: 'Use', innerHTML: html, parentElement: { innerText: `${text}\nUse`, innerHTML: html, querySelectorAll: () => [1] } })),
    'button,[role=button]': () => [{ offsetParent: {}, innerText: 'Next', click: () => state.clicked.push('Next') }],
    'span,div,label': () => [{ children: [], textContent: 'Show Lyrics', parentElement: { querySelector: () => ({ getAttribute: () => 'true', click: () => state.clicked.push('Show Lyrics') }) } }],
  };
  const visibleSongButton = restored ? 'Replace Song' : 'Select Song';
  const pageEvents = new Map();
  const emitPageEvent = (name, value) => (pageEvents.get(name) || []).forEach((handler) => handler(value));
  const locator = (sel, hasText, index = 0) => ({
    first: () => locator(sel, hasText, 0),
    locator: (next) => locator(next),
    nth: (nextIndex) => locator(sel, hasText, nextIndex),
    filter: (o) => locator(sel, o.hasText, index),
    count: async () => sel.includes('aria-busy') || sel.includes('progressbar') ? 0 : 1,
    waitFor: async () => {},
    fill: async () => {},
    inputValue: async () => 'Night Drive',
    setInputFiles: async () => {},
    evaluateAll: async () => [],
    boundingBox: async () => ({ x: 100, y: 400, width: 600, height: 80 }),
    click: async () => {
      if (sel === 'text=Select Song' && restored) throw new Error('element is not visible');
      if (sel === 'button:visible' && !hasText.test(visibleSongButton)) throw new Error('no visible song button');
      state.clicked.push(sel === 'button:visible' ? visibleSongButton : `${sel}[${index}]`);
    },
  });
  let downX = null;
  const page = {
    state,
    goto: async () => {},
    url: () => 'https://suno.com/hooks/create',
    on: (name, handler) => pageEvents.set(name, [...(pageEvents.get(name) || []), handler]),
    off: (name, handler) => pageEvents.set(name, (pageEvents.get(name) || []).filter((candidate) => candidate !== handler)),
    waitForTimeout: async (ms) => {
      if (delayedSongResults && ms === 250) {
        state.songPolls += 1;
        if (state.songPolls === 1) {
          state.songRowsRequest = { resourceType: () => 'fetch', url: () => '/api/search?q=Night%20Drive', postData: () => null };
          emitPageEvent('request', state.songRowsRequest);
          state.songRows = [{ text: 'Other Song 3:07', html: '' }];
        }
        if (state.songPolls === 2) {
          emitPageEvent('response', { request: () => state.songRowsRequest, ok: () => true, status: () => 200, json: async () => ({ clips: [{ id: ID }] }) });
          emitPageEvent('requestfinished', state.songRowsRequest);
          state.songRows = [{ text: 'Night Drive 3:42', html: '' }, { text: 'Night Drive 3:07', html: '' }];
        }
      } else if (!delayedSongResults && ms === 250) {
        state.songPolls += 1;
        if (state.songPolls === 1) {
          const request = { resourceType: () => 'fetch', url: () => '/api/search?q=Night%20Drive', postData: () => null };
          emitPageEvent('request', request);
          if (failedSearch) emitPageEvent('requestfailed', request);
          else {
            emitPageEvent('response', { request: () => request, ok: () => searchStatus === 200, status: () => searchStatus, json: async () => ({ clips: [{ id: ID }] }) });
            emitPageEvent('requestfinished', request);
          }
        }
        if (!failedSearch && searchStatus === 200 && state.songPolls === appliedAfterPoll) state.songRows = [{ text: 'Night Drive 3:42', html: '<span>Search result</span>' }];
      }
    },
    locator: (sel) => locator(sel),
    viewportSize: () => ({ width: 1280, height: 800 }),
    getByRole: () => ({ or: () => ({
      count: async () => 1,
      evaluate: async fn => fn({ getAttribute: () => String(state.lyrics) }),
      elementHandle: async () => ({ getAttribute: () => String(state.lyrics) }),
      click: async () => { state.lyrics = !state.lyrics; state.clicked.push('Show Lyrics'); },
    }) }),
    waitForFunction: async (fn, arg) => {
      globalThis.getComputedStyle = () => ({ visibility: 'visible' });
      globalThis.location = { href: 'https://suno.com/hooks/create' };
      globalThis.document = { querySelector: () => ({}), querySelectorAll: (sel) => sel === 'video' ? [{ readyState: 2, videoWidth: 100, currentSrc: "blob:uploaded" }] : dom[sel]?.() ?? [] };
      const value = fn(arg);
      if (!value) throw new Error('state did not change');
      return { jsonValue: async () => value };
    },
    evaluate: async (fn, arg) => {
      globalThis.document = { querySelectorAll: (sel) => dom[sel]?.() ?? [] };
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
  afterEach(() => { delete globalThis.document; delete globalThis.location; delete globalThis.getComputedStyle; });

  it('moves a window Suno opened at 2:38 to 0:20, reading the pill rather than the player clock', async () => {
    const page = hookPage({ windowAt: 158 });
    const summary = await sunoHookAdapter.prepare(page, hookPayload());
    expect(Math.abs(summary.windowStart - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(page.state.windowAt - 20)).toBeLessThanOrEqual(1);
    expect(page.state.drags).toBeGreaterThan(1); // the waveform is narrower than 138 s of drag
    expect(page.state.clicked).not.toContain('Post');
    expect(summary).not.toHaveProperty('cut');
  });

  it.each(['slider', 'canvas', 'legacy'])('finds the window through the %s compatibility path', async (waveformKind) => {
    const page = hookPage({ windowAt: 20, waveformKind });
    expect(await sunoHookAdapter.prepare(page, hookPayload())).toMatchObject({ windowStart: 20 });
  });

  it('refuses a missing window readout even when another timestamp matches the requested start', async () => {
    const page = hookPage({ noWindowReadout: true });
    await expect(sunoHookAdapter.prepare(page, hookPayload({ startSec: 222 }))).rejects.toThrow('no window label to read');
    expect(page.state.drags).toBe(0);
    expect(page.state.clicked).not.toContain('Next');
  });

  it('refuses ambiguous readouts and canvas strips before opening the Post dialog', async () => {
    const readout = hookPage({ ambiguousReadout: true });
    await expect(sunoHookAdapter.prepare(readout, hookPayload())).rejects.toThrow('no window label to read');
    expect(readout.state.clicked).not.toContain('Next');
    const waveform = hookPage({ waveformKind: 'canvas', ambiguousWaveform: true });
    await expect(sunoHookAdapter.prepare(waveform, hookPayload())).rejects.toThrow('state did not change');
    expect(waveform.state.drags).toBe(0);
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

  it('waits for changing search rows to settle before clicking the exact matching song', async () => {
    const page = hookPage({ delayedSongResults: true });
    await sunoHookAdapter.prepare(page, hookPayload({ songId: ID, durationSec: 187 }));
    expect(page.state.clicked).toContain('[role=dialog] button[1]');
    expect(page.state.clicked).not.toContain('[role=dialog] button[0]');
  });

  it.each([{ failedSearch: true }, { searchStatus: 503 }])('refuses stale matching rows after an unsuccessful search (%j)', async options => {
    const page = hookPage(options);
    await expect(sunoHookAdapter.prepare(page, hookPayload())).rejects.toThrow(/Suno search.*fail/i);
    expect(page.state.clicked).not.toContain('[role=dialog] button[0]');
    expect(page.state.clicked).not.toContain('Next');
  });

  it('waits for successful search results to be applied before selecting a matching old row', async () => {
    const page = hookPage({ appliedAfterPoll: 6 });
    await sunoHookAdapter.prepare(page, hookPayload());
    expect(page.state.songPolls).toBeGreaterThanOrEqual(6);
    expect(page.state.clicked).toContain('[role=dialog] button[0]');
  });
});
