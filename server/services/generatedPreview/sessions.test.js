import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ page: null, playback: null, onEvent: null }));
vi.mock('../musicVideo/projects.js', () => ({ getProject: async () => ({ composition: { document: { directory: 'example-document' } } }) }));
vi.mock('../musicVideo/documentRender.js', () => ({ openIsolatedDocumentPreview: async ({ onEvent }) => {
  fixture.onEvent = onEvent;
  return { page: fixture.page, scratchRoot: null, width: 390, height: 219, fps: 30, durationSec: 10,
    ...(fixture.playback ? { playback: fixture.playback } : {}) };
} }));
vi.mock('./codeAnimationPage.js', async (importOriginal) => ({
  ...await importOriginal(),
  stageCodeAnimationPage: async () => ({ scratchRoot: null, directory: 'example-animation' }),
}));
vi.mock('../htmlComposition/browser.js', () => ({ openComposition: async (_directory, options) => { fixture.onEvent = options.onEvent; return fixture.page; } }));
const saveRecording = vi.hoisted(() => vi.fn());
vi.mock('./recordingSave.js', () => ({ saveRecordingToMediaHistory: saveRecording }));
import { AUTHORED_PREVIEW_PLAYBACK_TARGET } from '../../lib/generatedPreviewPlaybackSchema.js';
import { closeSession, registerGeneratedPreviewHandlers } from './sessions.js';

const socket = { id: 'preview-test-socket', handlers: new Map(), emit: vi.fn(), on(event, fn) { this.handlers.set(event, fn); } };
afterEach(async () => { for (const [event, payload] of socket.emit.mock.calls) if (event === 'generated-preview:opened') await closeSession(payload.sessionId); socket.handlers.clear(); socket.emit.mockClear(); fixture.playback = null; });

// Catches playback state being lost at the queued worker boundary, especially the final pause behind an active seek.
describe('isolated document preview playback', () => {
  it('captures motion during play and the exact frame after a queued pause, while rejecting another socket', async () => {
    const frame = { t: 0, playing: false };
    let hold;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const globals = {
      __portosFilmLook: { apply() {}, playback(on) { frame.playing = on; } },
      __portosTitleCard: { apply() {} },
      portosComposition: { async seek(t) {
        frame.t = t;
        if (t === 1) { entered(); await new Promise((resolve) => { hold = resolve; }); }
      } },
    };
    fixture.page = {
      evaluate: (source) => new Function('globalThis', 'window', 'return ' + source)(globals, { postMessage() {} }),
      send: async () => ({ data: JSON.stringify(frame) }),
      close: async () => {},
    };
    registerGeneratedPreviewHandlers(socket);
    const requestId = '00000000-0000-4000-8000-000000000001';
    socket.handlers.get('generated-preview:open')({ requestId, kind: 'music-video', projectId: 'example' });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:opened', expect.any(Object)));
    const sessionId = socket.emit.mock.calls.find(([event]) => event === 'generated-preview:opened')[1].sessionId;
    const seek = (generation, t, playing) => socket.handlers.get('generated-preview:seek')({ requestId, sessionId, generation, t, ...(playing === undefined ? {} : { playing }) });
    seek(1, 1, true);
    await started;
    seek(2, 2, true);
    seek(3, 3); // Older clients and explicit seeks default to the exact filter.
    await Promise.resolve();
    hold();
    await vi.waitFor(() => expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:frame').at(-1)[1]).toMatchObject({ generation: 3, data: JSON.stringify({ t: 3, playing: false }) }));
    expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:frame').map(([, payload]) => JSON.parse(payload.data))).toEqual([
      { t: 0, playing: false }, { t: 1, playing: true }, { t: 3, playing: false },
    ]);
    const other = { ...socket, id: 'other-preview-socket', handlers: new Map() };
    registerGeneratedPreviewHandlers(other);
    other.handlers.get('generated-preview:seek')({ requestId, sessionId, generation: 4, t: 4, playing: true });
    await Promise.resolve();
    expect(frame).toEqual({ t: 3, playing: false });
  });
});

// Uniquely catches capture resets on clock anchors, stale preparing epochs,
// and old stream credits crossing an exact pause through the public socket.
describe('cooperative playback through preview sockets', () => {
  const requestId = '00000000-0000-4000-8000-000000000002';
  const frames = () => socket.emit.mock.calls.filter(([name]) => name === 'generated-preview:frame').map(([, payload]) => payload);
  const states = () => socket.emit.mock.calls.filter(([name]) => name === 'generated-preview:playback-state').map(([, payload]) => payload);
  async function openedPage({ rejectPlay = false, authored = false } = {}) {
    let lifetime = 0;
    let capturing = false;
    let holdPrepare = null;
    let heldSeek = null;
    let heldCapture = null;
    let heldPause = null;
    let heldPlay = null;
    const authoredResponses = new Map();
    const authoredCalls = [];
    let resyncMethod = null;
    let resyncEvent = false;
    let autoDrain = true;
    const log = [];
    const frame = { t: 0, playing: false };
    const nativeFrame = (data = JSON.stringify(frame)) => fixture.onEvent({ method: 'Page.screencastFrame', params: { sessionId: lifetime, data } });
    const globals = {
      __portosFilmLook: { apply(value) { log.push(['look', value]); }, playback(on) { frame.playing = on; } }, __portosTitleCard: { apply(value) { log.push(['card', value]); } },
      portosComposition: {
        async seek(t) { log.push(['seek', t]); if (heldSeek?.t === t) await heldSeek.promise; frame.t = t; },
        previewPlayback: {
          clock: () => 123,
          async pause() { log.push(['pause']); frame.playing = false; if (heldPause) await heldPause; },
          async prepare({ epoch, t }) { log.push(['prepare', epoch, t]); if (holdPrepare) await holdPrepare; return { status: 'prepared', epoch }; },
          async play({ epoch, sequence }) {
            if (rejectPlay) throw new Error('Synthetic native play rejection'); log.push(['play', epoch]); if (heldPlay) await heldPlay; frame.playing = true;
            if (resyncMethod === 'play' && resyncEvent) fixture.onEvent({ method: 'Portos.preview', params: { type: 'portos-mv:playback-resync', epoch, sequence } });
            return { status: resyncMethod === 'play' ? 'resync-required' : 'playing', epoch };
          },
          sync({ epoch, sequence }) {
            log.push(['sync', epoch]);
            if (resyncMethod === 'sync' && resyncEvent) fixture.onEvent({ method: 'Portos.preview', params: { type: 'portos-mv:playback-resync', epoch, sequence } });
            return { status: resyncMethod === 'sync' ? 'resync-required' : 'accepted', epoch };
          },
        },
      },
    };
    if (authored) {
      const original = globals.portosComposition.previewPlayback;
      const response = (method, args, value) => authoredResponses.has(method) ? authoredResponses.get(method)(args) : value;
      globals[AUTHORED_PREVIEW_PLAYBACK_TARGET] = Object.freeze({
        clock(args) { authoredCalls.push(['clock', args]); return response('clock', args, original.clock()); },
        async pause(args) { authoredCalls.push(['pause', args]); await original.pause(args); return response('pause', args, { epoch: args.epoch, status: 'paused' }); },
        async prepare(args) { authoredCalls.push(['prepare', args]); await original.prepare(args); return response('prepare', args, { epoch: args.epoch, sequence: args.sequence, status: 'prepared', t: args.t }); },
        async play(args) { authoredCalls.push(['play', args]); const value = await original.play(args); return response('play', args, { ...value, sequence: args.sequence }); },
        async sync(args) { authoredCalls.push(['sync', args]); const value = await original.sync(args); return response('sync', args, { ...value, sequence: args.sequence, driftSec: 0 }); },
      });
    }
    fixture.playback = { ...(authored ? { producer: 'authored-v1' } : {}), version: 1, fps: 30, presentation: 'atomic-canvas-v1', mediaTiming: 'staged-output-v1' };
    fixture.page = {
      evaluate: (source) => new Function('globalThis', 'window', 'return ' + source)(globals, { postMessage() {} }),
      send: async (method) => {
        log.push([method]);
        if (method === 'Page.startScreencast') { lifetime += 1; capturing = true; }
        if (method === 'Page.stopScreencast') capturing = false;
        if (method === 'Page.captureScreenshot') { if (capturing && autoDrain) nativeFrame(); if (heldCapture) await heldCapture; return { data: JSON.stringify(frame) }; }
        return {};
      },
      close: vi.fn(async () => { log.push(['close']); }),
    };
    registerGeneratedPreviewHandlers(socket);
    socket.handlers.get('generated-preview:open')({ requestId, kind: 'music-video', projectId: 'example' });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:opened', expect.objectContaining({ playback: { ...fixture.playback } })));
    const sessionId = socket.emit.mock.calls.find(([name]) => name === 'generated-preview:opened')[1].sessionId;
    const send = (payload) => socket.handlers.get('generated-preview:playback')({ requestId, sessionId, ...payload });
    return { sessionId, send, nativeFrame, frame, log, authoredCalls, replacePublic() { globals.portosComposition.previewPlayback = new Proxy({}, { get() { throw new Error('Mutable public producer was dispatched'); } }); }, response(method, fn) { authoredResponses.set(method, fn); }, holdPlay(promise) { heldPlay = promise; }, hold(promise) { holdPrepare = promise; }, holdSeek(t, promise) { heldSeek = { t, promise }; }, holdCapture(promise) { heldCapture = promise; }, holdPause(promise) { heldPause = promise; }, nativeResync(method, event = false) { resyncMethod = method; resyncEvent = event; }, blockDrain() { autoDrain = false; } };
  }

  it.each(['event', 'play-return', 'sync-return', 'play-race', 'sync-race'])('notifies the master before owned pause retires and deduplicates native resync (%s)', async scenario => {
    const page = await openedPage();
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'ready' })));
    const playFailure = scenario.startsWith('play');
    if (!playFailure) {
      page.send({ action: 'play', epoch: 1, sequence: 2, t: 1, workerTime: 123 });
      await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'playing' })));
    }
    const pauses = page.log.filter(([name]) => name === 'pause').length;
    let release;
    page.holdPause(new Promise(resolve => { release = resolve; }));
    try {
      if (scenario === 'event') fixture.onEvent({ method: 'Portos.preview', params: { type: 'portos-mv:playback-resync', epoch: 1, sequence: 2 } });
      else {
        const action = playFailure ? 'play' : 'sync';
        page.nativeResync(action, scenario.endsWith('race'));
        page.send({ action, epoch: 1, sequence: playFailure ? 2 : 3, t: 1, workerTime: 123 });
      }
      await vi.waitFor(() => expect(states().filter(state => state.status === 'resync-required')).toHaveLength(1));
      expect(states().find(state => state.status === 'resync-required')).toMatchObject({ requestId, sessionId: page.sessionId, epoch: 1, reason: 'clock' });
      await vi.waitFor(() => expect(page.log.filter(([name]) => name === 'pause')).toHaveLength(pauses + 1));
      const count = frames().length;
      page.nativeFrame('stale-after-resync');
      fixture.onEvent({ method: 'Portos.preview', params: { type: 'portos-mv:playback-resync', epoch: 1, sequence: 3 } });
      expect(frames()).toHaveLength(count);
      expect(states().filter(state => state.status === 'resync-required')).toHaveLength(1);
      page.send({ action: 'prepare', epoch: 2, sequence: 1, generation: 2, t: 2 });
      await Promise.resolve();
      expect(page.log).not.toContainEqual(['prepare', 2, 2]);
    } finally { release(); }
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'prepare', epoch: 2, status: 'ready' })));
    expect(page.log.filter(([name]) => name === 'pause')).toHaveLength(pauses + 2);
    expect(states().filter(state => state.status === 'resync-required')).toHaveLength(1);
  });

  it('plays continuously between ordered anchors, drains once, and a pause supersedes asynchronous preparation', async () => {
    const page = await openedPage();
    page.send({ action: 'clock', probeId: 1, clientTime: 100 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'clock', workerTime: 123, clientTime: 100 })));
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'prepare', epoch: 1, status: 'ready' })));
    page.send({ action: 'play', epoch: 1, sequence: 2, t: 1, workerTime: 123 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'play', status: 'playing' })));
    const afterStart = page.log.length;
    page.nativeFrame('complete-frame-a');
    page.send({ action: 'sync', epoch: 1, sequence: 3, t: 1.25, workerTime: 373 });
    page.send({ action: 'sync', epoch: 1, sequence: 2, t: 0, workerTime: 0 });
    await vi.waitFor(() => expect(page.log).toContainEqual(['sync', 1]));
    page.nativeFrame('complete-frame-b');
    expect(frames().slice(-2)).toMatchObject([{ playbackEpoch: 1, sequence: 1, data: 'complete-frame-a' }, { playbackEpoch: 1, sequence: 2, data: 'complete-frame-b' }]);
    expect(frames().slice(-2).every(frame => !('generation' in frame))).toBe(true);
    expect(page.log.slice(afterStart).filter(([name]) => ['seek', 'Page.captureScreenshot', 'Page.startScreencast'].includes(name))).toEqual([]);
    let release;
    page.hold(new Promise(resolve => { release = resolve; }));
    page.send({ action: 'prepare', epoch: 2, sequence: 1, generation: 2, t: 2 });
    page.nativeFrame('queued-old-frame');
    await vi.waitFor(() => expect(page.log).toContainEqual(['prepare', 2, 2]));
    socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation: 3, t: 3 });
    await Promise.resolve();
    release();
    await vi.waitFor(() => expect(frames().at(-1)).toMatchObject({ generation: 3, data: JSON.stringify({ t: 3, playing: false }) }));
    expect(frames().some(frame => frame.generation === 2 || frame.data === 'queued-old-frame')).toBe(false);
    expect(page.log.filter(([name]) => name === 'Page.startScreencast')).toHaveLength(1);
    expect(page.log.filter(([name]) => name === 'Page.stopScreencast')).toHaveLength(1);
  });

  it('closes a rejected native play with a correlated terminal error and no retry', async () => {
    const page = await openedPage({ rejectPlay: true });
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'ready' })));
    page.send({ action: 'play', epoch: 1, sequence: 2, t: 1, workerTime: 123 });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:closed', { sessionId: page.sessionId, reason: 'playback-failed' }));
    expect(socket.emit).toHaveBeenCalledWith('generated-preview:error', expect.objectContaining({ requestId, sessionId: page.sessionId, code: 'PREVIEW_PLAYBACK_FAILED' }));
    expect(page.log.filter(([name]) => name === 'Page.startScreencast')).toHaveLength(0);
    expect(fixture.page.close).toHaveBeenCalledTimes(1);
  });

  it('never starts a stream when native resync cancels the startup repaint fence', async () => {
    const page = await openedPage();
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'ready' })));
    let release;
    page.holdCapture(new Promise(resolve => { release = resolve; }));
    const count = page.log.filter(([name]) => name === 'Page.captureScreenshot').length;
    page.send({ action: 'play', epoch: 1, sequence: 2, t: 1, workerTime: 123 });
    await vi.waitFor(() => expect(page.log.filter(([name]) => name === 'Page.captureScreenshot').length).toBe(count + 1));
    fixture.onEvent({ method: 'Portos.preview', params: { type: 'portos-mv:playback-resync', epoch: 1, sequence: 2 } });
    release();
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'resync-required', reason: 'clock' })));
    expect(page.log.filter(([name]) => name === 'Page.startScreencast')).toHaveLength(0);
    expect(states().some(state => state.status === 'playing')).toBe(false);
  });

  it('joins an earlier exact seek, retains both control mutations and rejects older pauses', async () => {
    const page = await openedPage();
    let release;
    page.holdSeek(1, new Promise(resolve => { release = resolve; }));
    const seek = (generation, t) => socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation, t });
    seek(1, 1);
    await vi.waitFor(() => expect(page.log).toContainEqual(['seek', 1]));
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 2, t: 2 });
    await Promise.resolve();
    expect(page.log.some(([name]) => name === 'prepare')).toBe(false);
    release();
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'prepare', status: 'ready' })));
    const command = (action, value) => socket.handlers.get('generated-preview:command')({ requestId, sessionId: page.sessionId, action, [action === 'film-look' ? 'look' : 'card']: value });
    command('film-look', { exposure: 0.5 });
    command('title-card', { enabled: true });
    seek(3, 3);
    page.send({ action: 'pause', epoch: 0, generation: 1, t: 0 });
    page.send({ action: 'pause', epoch: 1, generation: 2, t: 0 });
    await vi.waitFor(() => expect(frames().at(-1)).toMatchObject({ generation: 3, data: JSON.stringify({ t: 3, playing: false }) }));
    expect(page.log).toContainEqual(['look', { exposure: 0.5 }]);
    expect(page.log).toContainEqual(['card', { enabled: true }]);
    expect(page.log.filter(([name]) => name === 'seek').at(-1)).toEqual(['seek', 3]);
  });

  it('retains an in-flight seek position when a control changes and cancels obsolete control images', async () => {
    const page = await openedPage();
    let release;
    page.holdSeek(2, new Promise(resolve => { release = resolve; }));
    const seek = (generation, t) => socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation, t });
    const look = () => socket.handlers.get('generated-preview:command')({ requestId, sessionId: page.sessionId, action: 'film-look', look: { exposure: 0.25 } });
    seek(1, 2);
    await vi.waitFor(() => expect(page.log).toContainEqual(['seek', 2]));
    look();
    release();
    await vi.waitFor(() => expect(frames().at(-1)).toMatchObject({ generation: 1, data: JSON.stringify({ t: 2, playing: false }) }));
    const screenshots = page.log.filter(([name]) => name === 'Page.captureScreenshot').length;
    let releaseCapture;
    page.holdCapture(new Promise(resolve => { releaseCapture = resolve; }));
    look();
    await vi.waitFor(() => expect(page.log.filter(([name]) => name === 'Page.captureScreenshot').length).toBe(screenshots + 1));
    const count = frames().length;
    seek(2, 3);
    releaseCapture();
    await vi.waitFor(() => expect(frames().at(-1)).toMatchObject({ generation: 2, data: JSON.stringify({ t: 3, playing: false }) }));
    expect(frames().slice(count).map(frame => frame.generation)).toEqual([2]);
  });

  it('retains paused control mutations in order while skipping obsolete queued pictures', async () => {
    const page = await openedPage();
    const controlStart = page.log.length;
    const command = (action, value) => socket.handlers.get('generated-preview:command')({ requestId, sessionId: page.sessionId, action, [action === 'film-look' ? 'look' : 'card']: value });
    let release;
    page.holdCapture(new Promise(resolve => { release = resolve; }));
    const screenshots = page.log.filter(([name]) => name === 'Page.captureScreenshot').length, count = frames().length;
    command('film-look', { exposure: 0.1 });
    await vi.waitFor(() => expect(page.log.filter(([name]) => name === 'Page.captureScreenshot')).toHaveLength(screenshots + 1));
    command('title-card', { enabled: true });
    command('film-look', { exposure: 0.9 });
    release();
    await vi.waitFor(() => expect(frames()).toHaveLength(count + 1));
    expect(page.log.slice(controlStart).filter(([name]) => name === 'look' || name === 'card')).toEqual([
      ['look', { exposure: 0.1 }], ['card', { enabled: true }], ['look', { exposure: 0.9 }],
    ]);
    expect(page.log.filter(([name]) => name === 'Page.captureScreenshot')).toHaveLength(screenshots + 2);
  });

  it('preserves a newer preparation mode while an older queued control retires', async () => {
    const page = await openedPage();
    const controlStart = page.log.length;
    const command = action => socket.handlers.get('generated-preview:command')({ requestId, sessionId: page.sessionId, action, ...(action === 'film-look' ? { look: { exposure: 0.25 } } : { card: { enabled: true } }) });
    let releaseCapture, releasePrepare;
    page.holdCapture(new Promise(resolve => { releaseCapture = resolve; }));
    const screenshots = page.log.filter(([name]) => name === 'Page.captureScreenshot').length;
    command('film-look');
    await vi.waitFor(() => expect(page.log.filter(([name]) => name === 'Page.captureScreenshot')).toHaveLength(screenshots + 1));
    command('title-card');
    page.hold(new Promise(resolve => { releasePrepare = resolve; }));
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    releaseCapture();
    try {
      await vi.waitFor(() => expect(page.log).toContainEqual(['prepare', 1, 1]));
      command('film-look');
      expect(states()).toContainEqual(expect.objectContaining({ epoch: 1, status: 'resync-required', reason: 'controls' }));
      page.send({ action: 'prepare', epoch: 2, sequence: 2, generation: 1, t: 1 });
    } finally { releasePrepare(); }
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'prepare', epoch: 2, status: 'ready' })));
    expect(states().some(state => state.action === 'prepare' && state.epoch === 1 && state.status === 'ready')).toBe(false);
    expect(page.log.slice(controlStart).filter(([name]) => name === 'look' || name === 'card')).toEqual([
      ['look', { exposure: 0.25 }], ['card', { enabled: true }], ['look', { exposure: 0.25 }],
    ]);
  });

  it('resynchronizes a control edit during preparation before any obsolete ready acknowledgement', async () => {
    const page = await openedPage();
    let release;
    page.hold(new Promise(resolve => { release = resolve; }));
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(page.log).toContainEqual(['prepare', 1, 1]));
    socket.handlers.get('generated-preview:command')({ requestId, sessionId: page.sessionId, action: 'title-card', card: { enabled: true } });
    expect(states()).toContainEqual(expect.objectContaining({ action: 'sync', epoch: 1, status: 'resync-required', reason: 'controls' }));
    page.send({ action: 'prepare', epoch: 2, sequence: 2, generation: 1, t: 1 });
    release();
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'prepare', epoch: 2, status: 'ready' })));
    expect(states().some(state => state.action === 'prepare' && state.epoch === 1 && state.status === 'ready')).toBe(false);
    expect(page.log.findIndex(([name, value]) => name === 'card' && value?.enabled)).toBeLessThan(page.log.findIndex(([name, value]) => name === 'prepare' && value === 2));
  });

  it('delivers complete legacy playing frames between requests but never crosses pause into a new interval', async () => {
    const page = await openedPage();
    let release;
    page.holdSeek(1, new Promise(resolve => { release = resolve; }));
    const seek = (generation, t, playing = false) => socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation, t, playing });
    seek(1, 1, true);
    await vi.waitFor(() => expect(page.log).toContainEqual(['seek', 1]));
    seek(2, 2, true);
    release();
    await vi.waitFor(() => expect(frames().at(-1)).toMatchObject({ generation: 2 }));
    expect(frames()).toContainEqual(expect.objectContaining({ generation: 1, data: JSON.stringify({ t: 1, playing: true }) }));
    let releaseAgain;
    page.holdSeek(4, new Promise(resolve => { releaseAgain = resolve; }));
    seek(3, 4, true);
    await vi.waitFor(() => expect(page.log).toContainEqual(['seek', 4]));
    seek(4, 2);
    seek(5, 3, true);
    releaseAgain();
    await vi.waitFor(() => expect(frames().at(-1)).toMatchObject({ generation: 5 }));
    expect(frames().some(frame => frame.generation === 3 || frame.generation === 4)).toBe(false);
  });

  it('closes visibly when the sole native capture cannot drain within the transition bound', async () => {
    const page = await openedPage();
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'ready' })));
    page.send({ action: 'play', epoch: 1, sequence: 2, t: 1, workerTime: 123 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'playing' })));
    page.blockDrain();
    vi.useFakeTimers();
    try {
      socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation: 2, t: 2 });
      await vi.advanceTimersByTimeAsync(1501);
      expect(socket.emit).toHaveBeenCalledWith('generated-preview:closed', { sessionId: page.sessionId, reason: 'playback-failed' });
      expect(socket.emit).toHaveBeenCalledWith('generated-preview:error', expect.objectContaining({ code: 'PREVIEW_PLAYBACK_FAILED' }));
      expect(page.log.filter(([name]) => name === 'Page.startScreencast')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('dispatches authored playback through the bound bridge and retires before ordered controls and exact frames', async () => {
    const page = await openedPage({ authored: true });
    page.replacePublic();
    page.send({ action: 'clock', probeId: 1, clientTime: 100 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'clock', workerTime: 123 })));
    page.send({ action: 'prepare', epoch: 1, sequence: 7, generation: 1, t: 1 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'prepare', sequence: 7, status: 'ready' })));
    expect(page.authoredCalls).toContainEqual(['prepare', { epoch: 1, sequence: 7, t: 1 }]);
    page.send({ action: 'play', epoch: 1, sequence: 8, t: 1, workerTime: 123 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'play', status: 'playing' })));
    page.nativeFrame('authored-visible');
    expect(frames().at(-1)).toMatchObject({ playbackEpoch: 1, sequence: 1, data: 'authored-visible' });
    expect(frames().at(-1)).not.toHaveProperty('generation');
    page.send({ action: 'sync', epoch: 1, sequence: 9, t: 1.25, workerTime: 373 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ action: 'sync', sequence: 9, status: 'accepted' })));
    let release;
    page.holdPause(new Promise(resolve => { release = resolve; }));
    const emitted = frames().length;
    const controlStart = page.log.length;
    const pauses = page.authoredCalls.filter(([method]) => method === 'pause').length;
    socket.handlers.get('generated-preview:command')({ requestId, sessionId: page.sessionId, action: 'film-look', look: { exposure: 0.5 } });
    socket.handlers.get('generated-preview:command')({ requestId, sessionId: page.sessionId, action: 'title-card', card: { enabled: true } });
    page.nativeFrame('obsolete-control-frame');
    expect(frames()).toHaveLength(emitted);
    await vi.waitFor(() => expect(page.authoredCalls.filter(([method]) => method === 'pause')).toHaveLength(pauses + 1));
    expect(page.log.slice(controlStart).some(([method]) => method === 'look' || method === 'card')).toBe(false);
    release();
    await vi.waitFor(() => expect(page.log).toContainEqual(['card', { enabled: true }]));
    expect(page.log.slice(controlStart).filter(([method]) => method === 'look' || method === 'card')).toEqual([
      ['look', { exposure: 0.5 }], ['card', { enabled: true }],
    ]);
    await vi.waitFor(() => expect(frames().at(-1)).toMatchObject({ generation: 1 }));
    expect(socket.emit.mock.calls.some(([event]) => event === 'generated-preview:error')).toBe(false);
  });

  it('resynchronizes an allowed authored superseded play without admitting a stale capture stream', async () => {
    const page = await openedPage({ authored: true });
    page.response('play', args => ({ epoch: args.epoch, sequence: args.sequence, status: 'superseded' }));
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'ready' })));
    page.send({ action: 'play', epoch: 1, sequence: 2, t: 1, workerTime: 123 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ epoch: 1, status: 'resync-required', reason: 'clock' })));
    expect(page.log).not.toContainEqual(['Page.startScreencast']);
    page.send({ action: 'prepare', epoch: 2, sequence: 1, generation: 2, t: 2 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ epoch: 2, status: 'ready' })));
    expect(socket.emit.mock.calls.some(([event]) => event === 'generated-preview:error')).toBe(false);
    expect(page.authoredCalls.filter(([method]) => method === 'pause').length).toBeGreaterThanOrEqual(2);
  });

  it('waits for a canceled authored preparation to retire before the replacing exact seek', async () => {
    const page = await openedPage({ authored: true });
    let release;
    page.hold(new Promise(resolve => { release = resolve; }));
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(page.authoredCalls).toContainEqual(['prepare', { epoch: 1, sequence: 1, t: 1 }]));
    socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation: 2, t: 2 });
    expect(page.log).not.toContainEqual(['seek', 2]);
    release();
    await vi.waitFor(() => expect(frames().at(-1)).toMatchObject({ generation: 2, data: JSON.stringify({ t: 2, playing: false }) }));
    expect(states().some(state => state.action === 'prepare' && state.epoch === 1 && state.status === 'ready')).toBe(false);
    expect(frames().some(frame => frame.generation === 1)).toBe(false);
    const operations = page.authoredCalls.map(([method]) => method);
    expect(operations).toEqual(['pause', 'prepare', 'pause']);
  });

  it('closes a canceled held authored play without waiting for its late resolution or starting capture', async () => {
    const page = await openedPage({ authored: true });
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'ready' })));
    let release;
    page.holdPlay(new Promise(resolve => { release = resolve; }));
    page.send({ action: 'play', epoch: 1, sequence: 2, t: 1, workerTime: 123 });
    await vi.waitFor(() => expect(page.log).toContainEqual(['play', 1]));
    socket.handlers.get('generated-preview:close')({ requestId, sessionId: page.sessionId });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:closed', { sessionId: page.sessionId, reason: 'closed' }));
    expect(fixture.page.close).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(page.log).not.toContainEqual(['Page.startScreencast']);
    expect(states().some(state => state.status === 'playing')).toBe(false);
    expect(socket.emit.mock.calls.some(([event]) => event === 'generated-preview:error')).toBe(false);
  });

  it('closes at the authored pause deadline and never reuses its uncertain page for queued exact or control work', async () => {
    const page = await openedPage({ authored: true });
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'ready' })));
    page.send({ action: 'play', epoch: 1, sequence: 2, t: 1, workerTime: 123 });
    await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'playing' })));
    let release;
    page.holdPause(new Promise(resolve => { release = resolve; }));
    vi.useFakeTimers();
    try {
      socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation: 2, t: 2 });
      socket.handlers.get('generated-preview:command')({ requestId, sessionId: page.sessionId, action: 'film-look', look: { exposure: 0.5 } });
      const count = frames().length;
      page.nativeFrame('late-pause-frame');
      expect(frames()).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(2999);
      expect(fixture.page.close).not.toHaveBeenCalled();
      expect(page.log).not.toContainEqual(['seek', 2]);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.emit).toHaveBeenCalledWith('generated-preview:closed', { sessionId: page.sessionId, reason: 'playback-failed' });
      expect(fixture.page.close).toHaveBeenCalledOnce();
      expect(socket.emit).toHaveBeenCalledWith('generated-preview:error', expect.objectContaining({ code: 'PREVIEW_PLAYBACK_FAILED' }));
      expect(page.log).not.toContainEqual(['seek', 2]);
      expect(page.log).not.toContainEqual(['look', { exposure: 0.5 }]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(page.log).not.toContainEqual(['seek', 2]);
      expect(page.log).not.toContainEqual(['look', { exposure: 0.5 }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { release(); vi.useRealTimers(); }
  });

  it('rejects an overdue authored response even when its CDP microtask beats the host timer callback', async () => {
    const page = await openedPage({ authored: true });
    let release;
    let now = 100;
    page.hold(new Promise(resolve => { release = resolve; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(page.authoredCalls).toContainEqual(['prepare', { epoch: 1, sequence: 1, t: 1 }]);
      socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation: 2, t: 2 });
      now = 3101; // Advance monotonic time without allowing the timer to run.
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.emit).toHaveBeenCalledWith('generated-preview:closed', { sessionId: page.sessionId, reason: 'playback-failed' });
      expect(states().some(state => state.status === 'ready')).toBe(false);
      expect(page.log).not.toContainEqual(['seek', 2]);
      expect(fixture.page.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { release(); clock.mockRestore(); vi.useRealTimers(); }
  });

  it.each([
    ['prepare sequence', 'prepare', args => ({ ...args, sequence: args.sequence + 1, status: 'prepared' })],
    ['play epoch', 'play', args => ({ epoch: args.epoch + 1, sequence: args.sequence, status: 'playing' })],
    ['sync extra field', 'sync', args => ({ epoch: args.epoch, sequence: args.sequence, status: 'accepted', unexpected: true })],
    ['pause status', 'pause', args => ({ epoch: args.epoch, status: 'playing' })],
  ])('closes on an invalid authored %s response before any follow-up exact seek', async (_label, method, response) => {
    const page = await openedPage({ authored: true });
    page.response(method, response);
    let release;
    if (method === 'prepare') page.hold(new Promise(resolve => { release = resolve; }));
    page.send({ action: 'prepare', epoch: 1, sequence: 1, generation: 1, t: 1 });
    if (method === 'prepare') {
      await vi.waitFor(() => expect(page.authoredCalls).toContainEqual(['prepare', { epoch: 1, sequence: 1, t: 1 }]));
      // Even an obsolete invocation must validate before exact reuse.
      socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation: 2, t: 2 });
      release();
    }
    if (method !== 'prepare' && method !== 'pause') {
      await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'ready' })));
      page.send({ action: 'play', epoch: 1, sequence: 2, t: 1, workerTime: 123 });
      if (method === 'sync') {
        await vi.waitFor(() => expect(states()).toContainEqual(expect.objectContaining({ status: 'playing' })));
        page.send({ action: 'sync', epoch: 1, sequence: 3, t: 1.25, workerTime: 373 });
      }
    }
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:closed', { sessionId: page.sessionId, reason: 'playback-failed' }));
    socket.handlers.get('generated-preview:seek')({ requestId, sessionId: page.sessionId, generation: 2, t: 2 });
    await Promise.resolve();
    expect(page.log).not.toContainEqual(['seek', 2]);
    expect(socket.emit).toHaveBeenCalledWith('generated-preview:error', expect.objectContaining({ requestId, sessionId: page.sessionId, code: 'PREVIEW_PLAYBACK_FAILED' }));
    expect(fixture.page.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['nonfinite', () => Number.NaN],
    ['negative', () => -1],
    ['asynchronous', () => Promise.resolve(123)],
  ])('refuses an authored %s clock and closes its owned session', async (_label, response) => {
    const page = await openedPage({ authored: true });
    page.response('clock', response);
    page.send({ action: 'clock', probeId: 1, clientTime: 100 });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:closed', { sessionId: page.sessionId, reason: 'playback-failed' }));
    expect(states().some(state => state.action === 'clock')).toBe(false);
    expect(fixture.page.close).toHaveBeenCalledOnce();
  });

  it('accepts equal authored clock observations but closes on a later regression', async () => {
    const page = await openedPage({ authored: true });
    page.send({ action: 'clock', probeId: 1, clientTime: 100 });
    page.send({ action: 'clock', probeId: 2, clientTime: 100 });
    await vi.waitFor(() => expect(states().filter(state => state.action === 'clock')).toHaveLength(2));
    page.response('clock', () => 122);
    page.send({ action: 'clock', probeId: 3, clientTime: 101 });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:closed', { sessionId: page.sessionId, reason: 'playback-failed' }));
    expect(states().filter(state => state.action === 'clock')).toHaveLength(2);
  });

});

// Catches a scrub that the film's own requestAnimationFrame loop paints over,
// and a record that can't run because the taken-over clock was never released.
describe('code animation playhead', () => {
  it('holds the page clock at the scrubbed time, then hands it back for a real-time record', async () => {
    const drawn = [];
    let clock = 100;
    const win = {
      requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 1),
      renderFrame: (t) => drawn.push(t),
      postMessage: vi.fn(),
    };
    const tick = () => { win.renderFrame(clock); clock += 1; win.requestAnimationFrame(tick); };
    fixture.page = {
      evaluate: (source) => new Function('window', 'return ' + source)(win),
      send: async () => ({ data: 'frame' }),
      close: async () => {},
    };
    registerGeneratedPreviewHandlers(socket);
    const requestId = '00000000-0000-4000-8000-000000000002';
    socket.handlers.get('generated-preview:open')({ requestId, kind: 'code-animation', html: '<canvas></canvas>' });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:opened', expect.any(Object)));
    const sessionId = socket.emit.mock.calls.find(([event]) => event === 'generated-preview:opened')[1].sessionId;
    tick();
    await new Promise((resolve) => setTimeout(resolve, 20));

    socket.handlers.get('generated-preview:seek')({ requestId, sessionId, generation: 1, t: 2.5 });
    await vi.waitFor(() => expect(drawn.at(-1)).toBe(2.5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(drawn.at(-1)).toBe(2.5);

    socket.handlers.get('generated-preview:command')({ requestId, sessionId, generation: 1, action: 'record', message: { type: 'example:record' } });
    await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalledWith({ type: 'example:record' }, '*'));
    await vi.waitFor(() => expect(drawn.at(-1)).toBeGreaterThanOrEqual(100));
  });

  it('leaves a page without renderFrame on its own loop', async () => {
    let frames = 0;
    const win = { requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 1), postMessage: vi.fn() };
    const tick = () => { frames += 1; win.requestAnimationFrame(tick); };
    fixture.page = {
      evaluate: (source) => new Function('window', 'return ' + source)(win),
      send: async () => ({ data: 'frame' }),
      close: async () => {},
    };
    registerGeneratedPreviewHandlers(socket);
    const requestId = '00000000-0000-4000-8000-000000000003';
    socket.handlers.get('generated-preview:open')({ requestId, kind: 'code-animation', html: '<canvas></canvas>' });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:opened', expect.any(Object)));
    const sessionId = socket.emit.mock.calls.find(([event]) => event === 'generated-preview:opened')[1].sessionId;
    tick();

    socket.handlers.get('generated-preview:seek')({ requestId, sessionId, generation: 1, t: 2.5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = frames;
    await vi.waitFor(() => expect(frames).toBeGreaterThan(after + 3));
  });
});

// Catches a page filling Media History with blobs nobody asked for, and the
// saved video failing to reach the viewer that pressed Record.
describe('code animation real-time recording', () => {
  it('saves only a requested recording and hands the viewer its library video', async () => {
    saveRecording.mockResolvedValue({ id: 'upload-1', filename: 'upload-1.mp4', durationSec: 4 });
    const win = { requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 1), postMessage: vi.fn() };
    fixture.page = {
      evaluate: (source) => new Function('window', 'return ' + source)(win),
      send: async () => ({ data: 'frame' }),
      close: async () => {},
    };
    registerGeneratedPreviewHandlers(socket);
    const requestId = '00000000-0000-4000-8000-000000000004';
    socket.handlers.get('generated-preview:open')({ requestId, kind: 'code-animation', html: '<canvas></canvas>' });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:opened', expect.any(Object)));
    const sessionId = socket.emit.mock.calls.find(([event]) => event === 'generated-preview:opened')[1].sessionId;
    const recordings = () => socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:recording').map(([, payload]) => payload);

    // An unrequested blob is refused synchronously; an accepted one reaches the
    // save before the handler's first await.
    fixture.onEvent({ method: 'Portos.preview', params: { type: 'example:recorded', hasBlob: true } });
    expect(saveRecording).not.toHaveBeenCalled();

    await socket.handlers.get('generated-preview:command')({ requestId, sessionId, action: 'record', message: { type: 'example:record' }, title: 'Station boot' });
    fixture.onEvent({ method: 'Portos.preview', params: { type: 'example:recorded', hasBlob: true } });
    await vi.waitFor(() => expect(recordings().at(-1)).toMatchObject({ status: 'saved' }));
    expect(saveRecording).toHaveBeenCalledWith(fixture.page, { title: 'Station boot' });
    expect(recordings()).toEqual([
      { requestId, sessionId, status: 'saving' },
      { requestId, sessionId, status: 'saved', video: { id: 'upload-1', filename: 'upload-1.mp4', url: '/data/videos/upload-1.mp4', durationSec: 4 } },
    ]);

    fixture.onEvent({ method: 'Portos.preview', params: { type: 'example:recorded', hasBlob: true } });
    expect(saveRecording).toHaveBeenCalledTimes(1);
  });
});
