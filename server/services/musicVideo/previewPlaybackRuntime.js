/** Install layered preview scheduling inside the private engine closure. */
import { createPreviewPlaybackClock } from './previewPlaybackClock.js';
import { classifyPreviewPlaybackFrame } from './previewPlaybackFrames.js';
import { createPreviewPlaybackLayers } from './previewPlaybackLayers.js';

const playbackHelpers = { createPreviewPlaybackClock, createPreviewPlaybackLayers, classifyPreviewPlaybackFrame };

/** Serialized into an admitted layered preview's private engine closure. */
export function installLayeredPreviewPlayback(bridge, composition = globalThis.portosComposition, {
  createPreviewPlaybackClock, createPreviewPlaybackLayers, classifyPreviewPlaybackFrame,
} = playbackHelpers) {
  const FPS = 30;
  const FRAME_FRESH_MS = 100;
  let epoch = -1, lease = 0, sequence = -1, phase = 'idle', disposed = false, poisoned = false, motion = null;
  let handle = null, active = null, transition = null, posted = -1;
  const pending = new Set();
  const notified = new Set();
  const clock = createPreviewPlaybackClock(bridge);
  const { now, advance } = clock;
  const { stateAt, videoOf, keyOf, layersFit, sourceTarget, endHold, load, freshSource, publish, liveVideo, needsTransition } =
    createPreviewPlaybackLayers(bridge, { now, owns: (token) => token === lease && !disposed });
  let videoOwner = null;
  let transitionOwner = null;
  const error = (code) => Object.assign(new Error(code), { code });
  const check = (input, anchor = false) => {
    if (disposed) throw error('PLAYBACK_DISPOSED');
    if (poisoned) throw error('PLAYBACK_FAILED');
    if (!input || !Number.isSafeInteger(input.epoch) || input.epoch < 0
      || !Number.isFinite(input.t) || input.t < 0 || input.t > bridge.duration) throw error('PLAYBACK_ARGUMENT');
    if (anchor && (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || !Number.isFinite(input.workerTime))) throw error('PLAYBACK_ANCHOR');
  };
  const stopMedia = () => { for (const video of bridge.videos()) video.pause(); };
  const setMotion = (value) => {
    if (motion === value) return;
    motion = value;
    bridge.playback(value);
  };
  const settleFirst = (owner, result) => {
    clearTimeout(owner.timer);
    owner.timer = null;
    const resolve = owner.resolveFirst;
    owner.resolveFirst = null;
    resolve?.(result);
  };
  const retireVideo = (result = { epoch, status: 'superseded' }) => {
    const owner = videoOwner;
    videoOwner = null;
    if (!owner) return;
    try { if (owner.handle != null) owner.video.cancelVideoFrameCallback(owner.handle); }
    finally { owner.handle = null; settleFirst(owner, result); }
  };
  const retireTransition = () => {
    if (transitionOwner) clearTimeout(transitionOwner.timer);
    transitionOwner = null;
  };
  const cancel = (result) => {
    lease++;
    retireTransition();
    try { retireVideo(result); } catch { poisoned = true; }
    if (handle != null) cancelAnimationFrame(handle);
    handle = null; transition = null; phase = 'paused';
    try { setMotion(false); } catch { poisoned = true; }
    finally { stopMedia(); }
  };
  const tracked = (promise) => {
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const bounded = (operation, ms) => {
    let timer;
    const expiry = new Promise((_resolve, reject) => { timer = setTimeout(() => {
      poisoned = true; reject(error('PLAYBACK_TIMEOUT'));
    }, ms); });
    return Promise.race([operation, expiry]).finally(() => clearTimeout(timer));
  };
  const emit = (type, code) => {
    const key = `${epoch}:${type}`;
    if (notified.has(key)) return;
    notified.add(key);
    // Retain at most the current epoch's two possible terminal notifications.
    for (const item of notified) if (!item.startsWith(`${epoch}:`)) notified.delete(item);
    window.postMessage({ type, message: code, epoch, sequence }, '*');
  };
  const fail = (code) => { cancel(); emit('portos-mv:playback-error', code); };
  const resync = (driftSec) => {
    const result = { epoch, status: 'resync-required', driftSec };
    cancel(result); emit('portos-mv:playback-resync', 'PLAYBACK_RESYNC');
    return result;
  };
  const startMedia = async (item, token) => {
    const video = videoOf(item);
    if (!video || item.state.hold || item.endHold) { stopMedia(); return; }
    video.playbackRate = clock.rate;
    await video.play();
    if (token !== lease || disposed) video.pause();
  };
  const freshTransition = (owner) => {
    if (transitionOwner !== owner || owner.token !== lease || owner.epoch !== epoch || disposed) return false;
    const age = now() - owner.startedAt;
    if (age >= FRAME_FRESH_MS) { resync(age / 1000); return false; }
    return true;
  };
  const beginTransition = (token, startedAt) => {
    if (transitionOwner) return transitionOwner;
    retireVideo();
    stopMedia();
    const progress = { token, epoch, startedAt, timer: null };
    transitionOwner = progress;
    progress.timer = setTimeout(() => {
      if (transitionOwner === progress && token === lease && progress.epoch === epoch && !disposed) resync(FRAME_FRESH_MS / 1000);
    }, FRAME_FRESH_MS);
    return progress;
  };
  const ownVideo = (item, token, transitionLease = null) => {
    retireVideo();
    const video = videoOf(item);
    const owner = { epoch, token, video, scene: item.scene, layers: item.layers ?? null, handle: null, timer: null, resolveFirst: null,
      mediaTime: null, presentedFrames: null, lastFreshAt: now(), origin: null, bucket: -1, transitionLease };
    videoOwner = owner;
    const first = new Promise(resolve => { owner.resolveFirst = resolve; });
    const valid = () => videoOwner === owner && owner.epoch === epoch && token === lease && !disposed
      && phase === 'playing' && !transition && active?.source === video && active.scene === owner.scene && liveVideo(active);
    const arm = () => {
      if (!valid()) return;
      owner.handle = video.requestVideoFrameCallback((_at, metadata) => {
        owner.handle = null;
        if (!valid()) return;
        try {
          const at = now();
          if (owner.transitionLease && !freshTransition(owner.transitionLease)) return;
          const anchorGap = clock.anchorGap(at);
          if (anchorGap > 1000) { resync(anchorGap / 1000); return; }
          const next = stateAt(advance(at));
          if (at - owner.lastFreshAt >= FRAME_FRESH_MS) { resync((at - owner.lastFreshAt) / 1000); return; }
          const item = { ...next, source: video, layers: owner.layers };
          item.endHold = endHold(item);
          if (item.scene !== owner.scene || item.state.hold || item.endHold || !layersFit(item)) {
            // RAF owns the next scene/hold preparation. Never publish this old
            // callback under that new mapping, including during initial play.
            if (owner.resolveFirst) resync(0.1);
            else beginTransition(token, at);
            return;
          }
          const frame = classifyPreviewPlaybackFrame(owner, item, metadata, at, sourceTarget, FPS);
          if (frame.status === 'resync') { resync(frame.drift); return; }
          if (frame.status === 'skip') { arm(); return; }
          if (publish(item, token, () => !owner.transitionLease || freshTransition(owner.transitionLease))) {
            active = item;
            if (owner.transitionLease) { retireTransition(); owner.transitionLease = null; }
            settleFirst(owner, { epoch, status: 'playing', t: item.songTime, workerTime: now() });
          }
          arm();
        } catch { if (valid()) fail('PLAYBACK_FRAME'); }
      });
    };
    // This deadline starts at post-native-play arming, separately from source
    // alignment's 100 ms guard and the total 1.5 s play operation bound.
    owner.timer = setTimeout(() => { if (valid()) resync(FRAME_FRESH_MS / 1000); }, FRAME_FRESH_MS);
    try { arm(); } catch { fail('PLAYBACK_FRAME'); }
    return first;
  };
  const tick = () => {
    if (phase !== 'playing' || disposed) return;
    const token = lease;
    try {
      const at = now();
      if (transitionOwner && !freshTransition(transitionOwner)) return;
      const anchorGap = clock.anchorGap(at);
      if (anchorGap > 1000) { resync(anchorGap / 1000); return; }
      const t = advance(at), next = stateAt(t);
      const nextEndHold = active ? endHold({ ...next, source: active.source }) : false;
      if (needsTransition(active, next, nextEndHold)) {
        if (!transition) {
          if (videoOwner?.resolveFirst) { resync(0.1); return; }
          const progress = beginTransition(token, at);
          const task = bounded((async () => {
            const startedAt = progress.startedAt;
            let item = await load(t, token, true);
            if (!item || !freshTransition(progress)) return;
            let latest = stateAt(advance(now()));
            // A photo step that passed while loading is stale and never shown:
            // load the current one inside this transition's freshness bound.
            while (latest.scene === item.scene && (keyOf(latest) !== item.sourceKey || !layersFit({ ...latest, layers: item.layers }))) {
              item = await load(latest.songTime, token, true);
              if (!item || !freshTransition(progress)) return;
              latest = stateAt(advance(now()));
            }
            // Slow preparation must not silently play media behind the master.
            let fresh = freshSource(item, latest, startedAt);
            if (!fresh.valid) { resync(fresh.drift || (now() - startedAt) / 1000); return; }
            active = { ...fresh.item, endHold: endHold(fresh.item) };
            await startMedia(active, token);
            if (token !== lease || disposed) return;
            if (!freshTransition(progress)) return;
            fresh = freshSource(item, stateAt(advance(now())), startedAt);
            if (!fresh.valid) { resync(fresh.drift || (now() - startedAt) / 1000); return; }
            active = { ...fresh.item, endHold: endHold(fresh.item) };
            if (liveVideo(active)) {
              // The transition promise is still owned, but media preparation
              // is finished. Release its gate before the first callback arms.
              transition = null;
              await ownVideo(active, token, progress);
            } else if (publish(active, token, () => freshTransition(progress))) {
              posted = Math.floor(active.songTime * FPS + 1e-9);
              retireTransition();
            }
          })(), 3000);
          transition = tracked(task);
          task.then(() => { if (transition === task) transition = null; }, () => { if (token === lease) fail('PLAYBACK_MEDIA'); });
        }
      } else if (!transition) {
        const video = videoOf(active);
        if (video && !next.state.hold && !nextEndHold) {
          const target = sourceTarget({ ...next, source: video });
          if (Math.abs(video.currentTime - target) >= 0.1) { resync(video.currentTime - target); return; }
          video.playbackRate = clock.rate;
          if (videoOwner && at - videoOwner.lastFreshAt >= FRAME_FRESH_MS) { resync((at - videoOwner.lastFreshAt) / 1000); return; }
          // Fresh video frames are published only by their rVFC owner.
          if (phase === 'playing' && token === lease) handle = requestAnimationFrame(tick);
          return;
        }
        const frame = Math.floor(t * FPS + 1e-9);
        if (frame !== posted) {
          const item = { ...active, ...next };
          if (publish(item, token)) posted = frame;
        }
      }
    } catch { if (token === lease) fail('PLAYBACK_DRAW'); }
    if (phase === 'playing' && token === lease) handle = requestAnimationFrame(tick);
  };
  const api = {
    version: 1, fps: FPS, presentation: 'atomic-canvas-v1', mediaTiming: 'staged-output-v1',
    clock: now,
    prepare(input) {
      check(input);
      if (input.epoch < epoch) return Promise.resolve({ epoch: input.epoch, status: 'superseded' });
      cancel(); epoch = input.epoch; sequence = -1; posted = -1;
      const token = lease, previous = [...pending];
      const task = bounded((async () => {
        await Promise.allSettled(previous);
        if (token !== lease || disposed) return { epoch: input.epoch, status: 'superseded' };
        if (poisoned) throw error('PLAYBACK_FAILED');
        await bridge.ready;
        if (token !== lease || disposed) return { epoch: input.epoch, status: 'superseded' };
        const item = await load(input.t, token);
        if (!item) return { epoch: input.epoch, status: 'superseded' };
        if (!publish(item, token)) return { epoch: input.epoch, status: 'superseded' };
        active = item; phase = 'prepared';
        return { epoch, status: 'prepared', t: input.t };
      })(), 3000).catch((cause) => { if (token === lease) fail('PLAYBACK_PREPARE'); throw cause; });
      return tracked(task);
    },
    play(input) {
      check(input, true);
      if (input.epoch !== epoch || input.sequence <= sequence) return Promise.resolve({ epoch: input.epoch, status: 'stale' });
      if (phase !== 'prepared') throw error('PLAYBACK_NOT_PREPARED');
      const at = now(), age = clock.anchorAge(input, at);
      if (age < -0.1 || age > 1) return Promise.resolve(resync(age));
      const token = lease;
      sequence = input.sequence;
      clock.reset(clock.project(input, at), at);
      clock.acceptAnchor(at);
      phase = 'starting';
      const task = bounded((async () => {
        const project = () => stateAt(clock.project(input, now()));
        const wanted = project(), prepared = active;
        // Cold preparation precedes audio startup. Align its already-loaded
        // source once to the now-running master; never repeat this seek in sync.
        if (wanted.scene !== prepared.scene) return resync(wanted.songTime - prepared.songTime);
        let aligned = { ...wanted, source: prepared.source, sourceKey: prepared.sourceKey ?? null, layers: prepared.layers ?? null };
        if (videoOf(prepared)) {
          aligned = await load(wanted.songTime, token, true);
          if (token !== lease || disposed || !aligned) return { epoch: input.epoch, status: 'superseded' };
          if (aligned.source !== prepared.source) return resync(0.1);
        }
        const alignment = () => freshSource(aligned, project(), at);
        let fresh = alignment();
        if (!fresh.valid) return resync(fresh.drift || (now() - at) / 1000);
        active = { ...fresh.item, endHold: endHold(fresh.item) };
        await startMedia(active, token);
        if (token !== lease || disposed) return { epoch: input.epoch, status: 'superseded' };
        fresh = alignment();
        if (!fresh.valid) return resync(fresh.drift || (now() - at) / 1000);
        active = { ...fresh.item, endHold: endHold(fresh.item) };
        clock.reset(fresh.item.songTime, now());
        setMotion(true);
        phase = 'playing'; handle = requestAnimationFrame(tick);
        return liveVideo(active) ? ownVideo(active, token) : { epoch, status: 'playing', t: fresh.item.songTime, workerTime: now() };
      })(), 1500).catch((cause) => { if (token === lease) fail('PLAYBACK_MEDIA'); throw cause; });
      return tracked(task);
    },
    sync(input) {
      check(input, true);
      if (input.epoch !== epoch || input.sequence <= sequence || phase !== 'playing') return { epoch: input.epoch, status: 'stale' };
      const at = now(), age = clock.anchorAge(input, at);
      const drift = input.t + age - advance(at);
      sequence = input.sequence;
      if (age < -0.1 || age > 1 || Math.abs(drift) >= 0.1) return resync(drift);
      clock.acceptAnchor(at, drift);
      return { epoch, status: 'accepted', driftSec: drift };
    },
    pause(input) {
      if (!input || !Number.isSafeInteger(input.epoch) || input.epoch < 0) throw error('PLAYBACK_ARGUMENT');
      if (input.epoch < epoch) return Promise.resolve({ epoch: input.epoch, status: 'stale' });
      epoch = input.epoch; cancel();
      return Promise.allSettled([...pending]).then(() => {
        if (poisoned) throw error('PLAYBACK_FAILED');
        return { epoch: input.epoch, status: 'paused' };
      });
    },
    dispose() {
      disposed = true; cancel();
      return Promise.allSettled([...pending]).then(() => { bridge.dispose(); active = null; return { epoch, status: 'disposed' }; });
    },
  };
  Object.defineProperty(composition, 'previewPlayback', { value: api });
}

// Bind the same helpers when the scheduler runs in a document without module imports.
export const layeredPreviewPlaybackSource = `((playbackHelpers) => (${installLayeredPreviewPlayback.toString()}))({
  ${Object.entries(playbackHelpers).map(([name, helper]) => `${name}: ${helper.toString()}`).join(',\n')}
})`;
