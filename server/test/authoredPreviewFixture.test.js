import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { authoredPreviewFixtureFiles } from './authoredPreviewFixture.js';

afterEach(() => vi.useRealTimers());

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function documentFixture() {
  const listeners = new Map(), callbacks = new Map(), frontDraws = [];
  let clock = 100, handle = 0, currentTime = 0, reportedTime;
  const emit = type => { for (const fn of [...(listeners.get(type) || [])]) fn(); };
  const video = {
    paused: true, seeking: false, readyState: 4, duration: 30,
    get currentTime() { return reportedTime === undefined ? currentTime : reportedTime; },
    set currentTime(value) { currentTime = value; this.seeking = true; emit('seeking'); },
    set src(_value) { queueMicrotask(() => emit('loadeddata')); },
    addEventListener(type, fn, options) {
      const wrapped = options?.once ? () => { this.removeEventListener(type, wrapped); fn(); } : fn;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(wrapped);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    requestVideoFrameCallback(fn) { callbacks.set(++handle, fn); return handle; },
    cancelVideoFrameCallback(id) { callbacks.delete(id); },
    pause() { this.paused = true; },
    play() { this.paused = false; emit('playing'); return Promise.resolve(); },
    removeAttribute() {}, load() {},
  };
  const context = () => ({ reset() {}, fillRect() {}, drawImage() {}, strokeRect() {}, save() {}, restore() {}, resetTransform() {} });
  const frontContext = context();
  frontContext.drawImage = (...args) => frontDraws.push(args);
  const front = { width: 1920, height: 1080, getContext: () => frontContext };
  const back = { width: 1920, height: 1080, getContext: () => context() };
  const sandbox = {
    document: { getElementById: () => front, createElement: type => type === 'video' ? video : back, fonts: { ready: Promise.resolve() } },
    Image: function () { this.decode = () => Promise.resolve(); },
    location: { href: 'https://composition.invalid/index.html' }, URL,
    performance: { now: () => ++clock }, setTimeout, clearTimeout,
    postMessage: vi.fn(),
    requestAnimationFrame: vi.fn(), cancelAnimationFrame: vi.fn(),
    PORTOS_MV: { scenes: [{ sceneId: 'numbered', startSec: 0, endSec: 30,
      media: { kind: 'video', src: 'media/scene-numbered.webm', fps: 30, width: 640, height: 360, inSec: 0, outSec: 30 } }] },
  };
  sandbox.window = sandbox;
  runInNewContext(authoredPreviewFixtureFiles()['authored-engine.js'], sandbox);
  return {
    sandbox, video, callbacks, frontDraws,
    reportCurrentTime(value) { reportedTime = value; },
    seeked() { video.seeking = false; emit('seeked'); },
    presented(mediaTime) {
      expect(callbacks.size).toBe(1);
      const [id, fn] = callbacks.entries().next().value;
      callbacks.delete(id); fn(++clock, { mediaTime });
    },
  };
}

describe('emitted custom author exact source preparation', () => {
  it.each(['seeked-first', 'presented-first'])('publishes frame22 at millisecond PTS.733 after BOTH barriers (%s)', async order => {
    const fixture = documentFixture();
    let settled = false;
    const seek = fixture.sandbox.portosComposition.seek(.75).then(() => { settled = true; });
    await flush();
    expect(fixture.video.currentTime).toBe(.75);
    expect(fixture.frontDraws).toHaveLength(0);
    if (order === 'seeked-first') fixture.seeked();
    else fixture.presented(.733);
    await flush();
    expect(settled).toBe(false);
    expect(fixture.frontDraws).toHaveLength(0);
    if (order === 'seeked-first') fixture.presented(.733);
    else fixture.seeked();
    await seek;
    expect(settled).toBe(true);
    expect(fixture.frontDraws).toHaveLength(1);
    expect(fixture.sandbox.__authoredFixtureFacts.lastCommit.sourceTime).toBe(.75);
    expect(fixture.sandbox.__authoredFixtureFacts.exactPresentations[0].callbacks).toMatchObject([{ mediaTime: .733, sourceFrame: 22, qualified: true }]);
    expect(fixture.callbacks.size).toBe(0);
  });

  it('rejects previous, next, stale and off-grid presentations without visible commit, then accepts target22', async () => {
    const fixture = documentFixture();
    let settled = false;
    const seek = fixture.sandbox.portosComposition.seek(.75).then(() => { settled = true; });
    await flush(); fixture.seeked();
    for (const pts of [.7, .767, .233, .74, NaN, -.001]) {
      fixture.presented(pts); await flush();
      expect(settled).toBe(false);
      expect(fixture.frontDraws).toHaveLength(0);
      expect(fixture.callbacks.size).toBe(1);
    }
    fixture.presented(.733); await seek;
    expect(fixture.frontDraws).toHaveLength(1);
    expect(fixture.sandbox.__authoredFixtureFacts.exactPresentations[0].callbacks.map(row => row.qualified))
      .toEqual([false, false, false, false, false, false, true]);
  });

  it('retains the unchanged1500ms deadline and bounded private failed-callback facts', async () => {
    vi.useFakeTimers();
    const fixture = documentFixture();
    const seek = fixture.sandbox.portosComposition.seek(.75);
    const rejected = expect(seek).rejects.toThrow(/intendedFrame.*22.*seeked.*true.*mediaTime.*0.767/);
    await flush(); fixture.seeked();
    for (let i = 0; i < 12; i++) fixture.presented(.767);
    await vi.advanceTimersByTimeAsync(1499);
    expect(fixture.frontDraws).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(fixture.sandbox.__authoredFixtureFacts.exactPresentations[0].callbacks).toHaveLength(8);
    expect(fixture.sandbox.__authoredFixtureFacts.exactPresentations[0].timedOut).toBe(true);
    expect(fixture.callbacks.size).toBe(0);
    expect(fixture.frontDraws).toHaveLength(0);
  });

  it('reuses only an unchanged previously qualified paused target and invalidates it on playing', async () => {
    const fixture = documentFixture();
    const initial = fixture.sandbox.portosComposition.seek(.75);
    await flush(); fixture.seeked(); fixture.presented(.733); await initial;
    await fixture.sandbox.portosComposition.seek(.75);
    expect(fixture.callbacks.size).toBe(0);
    expect(fixture.frontDraws).toHaveLength(2);
    await fixture.video.play(); fixture.video.pause();
    let settled = false;
    const next = fixture.sandbox.portosComposition.seek(.75).then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(fixture.callbacks.size).toBe(1);
    fixture.seeked(); fixture.presented(.733); await next;
    expect(fixture.frontDraws).toHaveLength(3);
  });

  it('prepares the same repeating midpoint2 from the actual qualified exact source without another callback', async () => {
    const fixture = documentFixture();
    const initial = fixture.sandbox.portosComposition.seek(2);
    await flush(); fixture.seeked(); fixture.presented(2); await initial;
    const facts = fixture.sandbox.__authoredFixtureFacts;
    expect(fixture.video.currentTime).toBe(60.5 / 30);
    expect(facts.sourcePresentations[0]).toBe(facts.exactPresentations[0]);
    const result = await fixture.sandbox.portosComposition.previewPlayback.prepare({ epoch: 1, sequence: 1, t: 2 });
    expect(result).toEqual({ epoch: 1, sequence: 1, status: 'prepared', t: 2 });
    expect(fixture.callbacks.size).toBe(0);
    expect(fixture.frontDraws).toHaveLength(2);
    expect(facts.sourcePresentations[1]).toMatchObject({ kind: 'nonexact', requestedT: 2, intendedFrame: 60,
      target: 60.5 / 30, cacheDecision: 'hit', qualifiedPausedCache: true,
      entry: { paused: true, seeking: false, readyState: 4, currentTime: 60.5 / 30, qualifiedTarget: 60.5 / 30, targetDelta: 0 } });
  });

  it('reuses presented frame60 for measured getter2.016665 without another seek assignment or callback', async () => {
    const fixture = documentFixture();
    const initial = fixture.sandbox.portosComposition.seek(2);
    await flush(); fixture.seeked(); fixture.presented(2); await initial;
    const facts = fixture.sandbox.__authoredFixtureFacts;
    const invalidations = facts.cacheInvalidations.count;
    fixture.reportCurrentTime(2.016665);
    expect(Math.abs(fixture.video.currentTime - 60.5 / 30)).toBeGreaterThan(1e-6);
    const result = await fixture.sandbox.portosComposition.previewPlayback.prepare({ epoch: 1, sequence: 1, t: 2 });
    expect(result).toEqual({ epoch: 1, sequence: 1, status: 'prepared', t: 2 });
    expect(fixture.callbacks.size).toBe(0);
    expect(facts.cacheInvalidations.count).toBe(invalidations);
    expect(fixture.frontDraws).toHaveLength(2);
    expect(facts.sourcePresentations[1]).toMatchObject({ kind: 'nonexact', intendedFrame: 60,
      cacheDecision: 'hit', qualifiedPausedCache: true,
      entry: { currentTime: 2.016665, qualifiedTarget: 60.5 / 30 } });
  });

  it.each([
    ['previous-frame', 59.5 / 30], ['next-frame', 61.5 / 30],
    ['nonfinite', NaN], ['infinite', Infinity], ['negative', -1e-12],
  ])('requires an existing presentation barrier when qualified-target getter consistency fails (%s)', async (_label, getter) => {
    vi.useFakeTimers();
    const fixture = documentFixture();
    const initial = fixture.sandbox.portosComposition.seek(2);
    await flush(); fixture.seeked(); fixture.presented(2); await initial;
    fixture.reportCurrentTime(getter);
    let failure;
    const prepare = fixture.sandbox.portosComposition.previewPlayback.prepare({ epoch: 1, sequence: 1, t: 2 })
      .catch(error => { failure = error; });
    await flush(); fixture.seeked();
    const record = fixture.sandbox.__authoredFixtureFacts.sourcePresentations[1];
    expect(record).toMatchObject({ kind: 'nonexact', cacheDecision: 'miss', entry: { qualifiedTarget: 60.5 / 30 } });
    expect(fixture.callbacks.size).toBe(1);
    expect(fixture.frontDraws).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await prepare;
    expect(failure.message).toMatch(/^Authored presented-frame seek deadline /);
    expect(record.timedOut).toBe(true);
    expect(fixture.callbacks.size).toBe(0);
    expect(fixture.frontDraws).toHaveLength(1);
  });

  it.each([false, true])('keeps nonexact deadline facts after invalidation even with global retention exhausted (%s)', async overflow => {
    vi.useFakeTimers();
    const fixture = documentFixture();
    const initial = fixture.sandbox.portosComposition.seek(2);
    await flush(); fixture.seeked(); fixture.presented(2); await initial;
    const facts = fixture.sandbox.__authoredFixtureFacts;
    if (overflow) for (let i = 0; i < 63; i++) await fixture.sandbox.portosComposition.seek(2);
    await fixture.video.play(); fixture.video.pause();
    expect(facts.cacheInvalidations).toMatchObject({ count: 2, seeking: 1, playing: 1,
      last: { cause: 'playing', target: 60.5 / 30 } });
    let failure;
    const prepare = fixture.sandbox.portosComposition.previewPlayback.prepare({ epoch: 1, sequence: 1, t: 2 })
      .catch(error => { failure = error; });
    await flush(); fixture.seeked();
    for (let i = 0; i < 140; i++) fixture.presented(2.033);
    await vi.advanceTimersByTimeAsync(1499);
    expect(failure).toBeUndefined();
    expect(fixture.frontDraws).toHaveLength(overflow ? 64 : 1);
    await vi.advanceTimersByTimeAsync(1); await prepare;
    const prefix = 'Authored presented-frame seek deadline ';
    expect(failure.message.startsWith(prefix)).toBe(true);
    const detail = failure.message.slice(prefix.length);
    expect(detail.length).toBeLessThanOrEqual(2000);
    const summary = JSON.parse(detail);
    expect(summary).toMatchObject({ kind: 'nonexact', requestedT: 2, intendedFrame: 60, target: 60.5 / 30,
      entry: { currentTime: 60.5 / 30, paused: true, seeking: false, readyState: 4, qualifiedTarget: null },
      cacheDecision: 'miss', seeked: true, invalidation: { count: 3, seeking: 2, playing: 1,
        last: { cause: 'seeking', requestedTarget: 60.5 / 30 } } });
    expect(summary.callbacks.length).toBeGreaterThan(0);
    expect(summary.callbacks.length + summary.callbackRowsOmitted).toBe(8);
    expect(summary.callbacks.every(row => row.mediaTime === 2.033 && row.sourceFrame === 61 && !row.qualified && row.seeked)).toBe(true);
    expect(facts.sourcePresentations.length).toBeLessThanOrEqual(64);
    expect(facts.sourceCallbackCount).toBeLessThanOrEqual(128);
    expect(facts.sourceCallbackOverflow).toBeGreaterThan(0);
    if (overflow) expect(facts.sourcePresentationOverflow).toBe(1);
    else expect(facts.sourcePresentations.at(-1)).toMatchObject({ kind: 'nonexact', timedOut: true, seeked: true });
    expect(fixture.callbacks.size).toBe(0);
    expect(fixture.sandbox.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'portos-mv:playback-error' }), '*');
  });
});
