/** Host-owned producer packaged only into deliberately new Canvas candidates. */
import { installLayeredPreviewPlayback } from './previewPlaybackRuntime.js';

// Serialized beside the generated candidate's existing renderer. Original author
// functions retain the existing synchronous/deterministic section contract.
export function installGeneratedPlayback(composition, bridge, installScheduler) {
  let exactLease = 0, disposed = false, playing = false;
  const exactWork = new Set();
  const now = performance.now.bind(performance);
  const fail = message => { throw new Error(message); };
  const publish = (songTime, t, scene, source, state, valid = () => true) => {
    const started = now();
    bridge.draw(t, scene, source, state);
    // A section may block the event loop. Recheck after drawing, before title,
    // film look or front pixels change; token checks alone cannot catch that.
    if (disposed || !valid()) return false;
    if (now() - started >= 100) fail('Generated drawing exceeded frame freshness');
    if (playing && source && scene?.media?.kind === 'video') {
      const latestSongTime = songTime + (now() - started) / 1000;
      const latest = bridge.state(latestSongTime);
      if (bridge.scene(latest.t) !== scene || latest.hold !== state.hold || (state.hold && latest.t !== t)) fail('Generated scene changed during drawing');
      const clock = latest.hold ? latest.t : latestSongTime;
      const end = Math.min(Number.isFinite(scene.media.outSec) ? scene.media.outSec : source.duration, source.duration);
      const last = Math.max(0, end - 0.5 / (scene.media.fps || bridge.fps));
      const target = Math.min(Math.max((scene.media.inSec || 0) + clock - scene.startSec, scene.media.inSec || 0), last);
      if (source.readyState < 2 || source.seeking || !Number.isFinite(source.currentTime) || Math.abs(source.currentTime - target) >= 0.1) fail('Generated source changed during drawing');
    }
    bridge.finish(songTime);
    bridge.commit();
    return true;
  };
  const privateComposition = {};
  installScheduler({
    duration: bridge.duration, fps: bridge.fps, state: bridge.state, scene: bridge.scene,
    source: bridge.source, needsSource: bridge.needsSource, videos: bridge.videos,
    get ready() { return bridge.ready; },
    publish,
    playback(on) { playing = on; bridge.playback(on); },
    dispose() { disposed = true; exactLease++; bridge.dispose(); },
  }, privateComposition);
  const scheduler = privateComposition.previewPlayback;
  const retireExact = async () => { exactLease++; await Promise.allSettled([...exactWork]); };
  const reply = async (method, input) => {
    const result = await scheduler[method](input);
    if (method === 'prepare') {
      if (result.status !== 'prepared') fail('Generated preparation superseded');
      return { epoch: result.epoch, sequence: input.sequence, status: result.status, t: result.t };
    }
    return { epoch: result.epoch, sequence: input.sequence, status: result.status,
      ...(method === 'sync' && Number.isFinite(result.driftSec) ? { driftSec: result.driftSec } : {}) };
  };
  Object.defineProperty(composition, 'previewPlayback', { value: {
    version: 1, fps: 30, presentation: 'atomic-canvas-v1', mediaTiming: 'staged-output-v1',
    clock: () => scheduler.clock(),
    async prepare(input) { await retireExact(); return reply('prepare', input); },
    play: input => reply('play', input), sync: input => reply('sync', input),
    async pause(input) { exactLease++; const result = await scheduler.pause(input); await retireExact(); return result; },
    async dispose() {
      exactLease++;
      const disposal = scheduler.dispose(); // Stop native media before waiting on exact source work.
      await Promise.all([disposal, retireExact()]);
      return disposal;
    },
  } });
  // Own readiness and finishing here instead of retaining the init-script seek
  // wrappers: their font continuations would sit outside this cancellation lease.
  composition.seek = (songTime, { reviewFootage = false } = {}) => {
    const token = ++exactLease, previous = [...exactWork];
    const operation = (async () => {
      await Promise.allSettled(previous);
      await bridge.ready;
      if (token !== exactLease || disposed) return;
      const state = bridge.state(songTime), t = state.t, scene = bridge.scene(t);
      const source = scene && bridge.needsSource(scene) ? await bridge.source(scene, t) : null;
      if (token !== exactLease || disposed) return;
      bridge.draw(t, scene, source, state, reviewFootage);
      if (token !== exactLease || disposed) return;
      // Exact rendering retains its existing operation deadline, rather than a
      // live freshness limit. Its source clock is paused at the requested frame.
      bridge.finish(songTime);
      bridge.commit();
    })();
    exactWork.add(operation);
    operation.then(() => exactWork.delete(operation), () => exactWork.delete(operation));
    return operation;
  };
}

const BRIDGE = `
  (${installGeneratedPlayback.toString()})(globalThis.portosComposition, {
    get ready() { return Promise.all([ready, globalThis.__portosTitleCard?.ready?.()]); },
    duration: DURATION, fps: FPS,
    state: eventState, scene: sceneAt, source: sourceFor,
    needsSource: scene => !cardFor(scene),
    videos: () => [...videos.values()].map(entry => entry.el),
    playback: on => globalThis.__portosFilmLook?.playback(on),
    draw(t, scene, source, state, reviewFootage = false) {
      if (!generatedBack) {
        generatedBack = document.createElement('canvas');
        generatedBack.width = W; generatedBack.height = H;
      }
      if (generatedBack.width !== W) generatedBack.width = W;
      if (generatedBack.height !== H) generatedBack.height = H;
      const front = canvas, frontContext = ctx;
      // Keep the renderer's persistent state and paths, just as ordinary seek
      // does. Resetting here would change inherited typography/path semantics.
      try { canvas = generatedBack; ctx = generatedBack.getContext('2d'); render(t, scene, source, state, reviewFootage); }
      finally { canvas = front; ctx = frontContext; }
    },
    finish(songTime) {
      globalThis.__portosFilmLook?.frame(Math.round(songTime * FPS));
      globalThis.__portosTitleCard?.draw(songTime);
    },
    commit() {
      ctx.save();
      try {
        ctx.resetTransform(); ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'copy'; ctx.filter = 'none';
        ctx.drawImage(generatedBack, 0, 0);
      } finally { ctx.restore(); }
    },
    dispose() {
      for (const entry of videos.values()) { entry.el.pause(); entry.el.removeAttribute('src'); entry.el.load(); }
      videos.clear(); images.clear();
      if (generatedBack) { generatedBack.width = 0; generatedBack.height = 0; generatedBack = null; }
    },
  }, ${installLayeredPreviewPlayback.toString()});
`;

/** Canonical host seams only; never called for an existing/imported document. */
export function generatedCanvasPlaybackEngine(original) {
  let source = original.toString();
  for (const [from, to] of [
    ["  const canvas = document.getElementById('stage');", "  let canvas = document.getElementById('stage');"],
    ["  const ctx = canvas.getContext('2d');", "  let ctx = canvas.getContext('2d');\n  let generatedBack = null;"],
    ['    W = width; H = height;', '    W = width; H = height;\n    if (generatedBack) { generatedBack.width = 0; generatedBack.height = 0; generatedBack = null; }'],
    ['        authored.fn(source ? footageOverlayContext(ctx) : ctx, {', '        const drawing = authored.fn(source ? footageOverlayContext(ctx) : ctx, {'],
    ['          events: state.activeEvents, reactiveGain: state.reactiveGain, hold: state.hold,\n        });', '          events: state.activeEvents, reactiveGain: state.reactiveGain, hold: state.hold,\n        });\n        if (drawing && typeof drawing.then === \'function\') { Promise.resolve(drawing).catch(() => {}); throw new Error(\'Generated sections must draw synchronously\'); }'],
    ['\n})();\n', `${BRIDGE}\n})();\n`],
  ]) {
    if (source.split(from).length !== 2) throw new Error('Generated Canvas playback host seam changed');
    source = source.replace(from, () => to);
  }
  return Buffer.from(source);
}
