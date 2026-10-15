import { installLayeredPreviewPlayback } from '../services/musicVideo/previewPlaybackRuntime.js';

/**
 * Synthetic custom-document reference, not an admission rule or a shipped
 * template. Video comes exclusively from the host-staged selected take.
 * Resource preparation and full-frame publication belong to this author.
 */
export function authoredPreviewFixtureFiles() {
  return {
    'preview-playback.json': JSON.stringify({ version: 1, contract: 'portos-complete-frame-v1' }) + '\n',
    'badge-a.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#39e7c2"/><path d="M20 60L60 20L100 60L140 20L180 60L220 20" fill="none" stroke="#102528" stroke-width="8"/></svg>',
    'badge-b.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#ffb15f"/><circle cx="120" cy="40" r="26" fill="none" stroke="#251820" stroke-width="8"/></svg>',
    'index.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Authored complete-frame reference</title><style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}#stage{display:block;width:100vw;height:100vh;object-fit:contain}</style></head><body><canvas id="stage" width="1920" height="1080"></canvas><script src="portos-mv.js"></script><!-- portos-allow-hidden-content: host render-time project data --><script src="authored-engine.js"></script><!-- portos-allow-hidden-content: author-owned complete-frame engine --></body></html>`,
    'authored-engine.js': `(${authoredEngine.toString()})(${installLayeredPreviewPlayback.toString()});\n`,
  };
}

// This function is serialized into the imported document. It deliberately has
// no module closure, filesystem access, host controls, or expected pixel IDs.
function authoredEngine(installScheduler) {
  const W = 1920, H = 1080, FPS = 30, TIMELINE_FPS = 24, DURATION = 30;
  const selected = globalThis.PORTOS_MV?.scenes?.find(scene => scene.sceneId === 'numbered');
  const media = selected?.media;
  if (selected?.startSec !== 0 || selected?.endSec !== DURATION || media?.kind !== 'video'
    || media.fps !== FPS || media.inSec !== 0 || media.outSec !== DURATION || media.timing
    || media.width !== 640 || media.height !== 360 || !/^media\/[A-Za-z0-9_.-]+$/.test(media.src)) throw Error('Authored fixture requires the staged selected thirty-second source');
  const front = document.getElementById('stage'), back = document.createElement('canvas');
  back.width = W; back.height = H;
  const frontContext = front.getContext('2d'), backContext = back.getContext('2d');
  const video = document.createElement('video');
  video.id = 'clip'; video.crossOrigin = 'anonymous'; video.muted = true; video.playsInline = true; video.preload = 'auto';
  // Passive reference for this synthetic fixture's existing out-of-window
  // facts read; it remains detached and receives no observer-driven calls.
  globalThis.__authoredFixtureVideo = video;
  const facts = { kind: 'explicit-custom-author-reference', asyncResources: 0, exactSeeks: 0,
    completeCommits: 0, sceneTransitions: 0, sceneIds: [], lastCommit: null, disposed: false,
    exactPresentations: [], exactPresentationOverflow: 0, exactCallbackCount: 0, exactCallbackOverflow: 0,
    sourcePresentations: [], sourcePresentationOverflow: 0, sourceCallbackCount: 0, sourceCallbackOverflow: 0,
    cacheInvalidations: { count: 0, seeking: 0, playing: 0, last: null },
    stagedSource: { sceneId: selected.sceneId, src: media.src, fps: media.fps, inSec: media.inSec, outSec: media.outSec, width: media.width, height: media.height } };
  globalThis.__authoredFixtureFacts = facts;
  const scenes = [
    { sceneId: 'authored-a', startSec: 0, endSec: 14, badge: 0 },
    { sceneId: 'authored-b', startSec: 14, endSec: DURATION, badge: 1 },
  ];
  const sceneAt = t => scenes[t >= 14 ? 1 : 0];
  // Visual scene boundaries do not change this continuous selected source.
  const mediaScene = { sceneId: 'continuous-selected-source', startSec: 0, endSec: DURATION,
    media: { kind: 'video', fps: FPS, inSec: 0, outSec: DURATION } };
  const stateAt = t => ({ t: Math.max(0, Math.min(DURATION - 1 / FPS, t)), hold: false });
  let disposed = false, exactLease = 0, lastScene = null, qualifiedExactTarget = null;
  const finite = value => Number.isFinite(value) ? value : null;
  let lastRequestedTarget = null;
  const invalidateQualifiedTarget = cause => {
    facts.cacheInvalidations.count++; facts.cacheInvalidations[cause]++;
    facts.cacheInvalidations.last = { cause, at: performance.now(), target: finite(qualifiedExactTarget),
      requestedTarget: finite(lastRequestedTarget), currentTime: finite(video.currentTime) };
    qualifiedExactTarget = null;
  };
  video.addEventListener('playing', () => { invalidateQualifiedTarget('playing'); });
  video.addEventListener('seeking', () => { invalidateQualifiedTarget('seeking'); });
  const exactWork = new Set();
  const loadedVideo = new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', () => { facts.asyncResources++; resolve(video); }, { once: true });
    video.addEventListener('error', () => reject(Error('Authored video resource failed')), { once: true });
  });
  video.src = new URL(media.src, location.href).href;
  const badges = ['badge-a.svg', 'badge-b.svg'].map(name => {
    const image = new Image(); image.crossOrigin = 'anonymous'; image.src = new URL(name, location.href).href;
    return image.decode().then(() => { facts.asyncResources++; return image; });
  });
  let images;
  const ready = Promise.all([loadedVideo, ...badges, document.fonts.ready]).then(values => { images = values.slice(1, 3); });
  // Register before assigning currentTime. A stale pre-seek presentation cannot
  // release the barrier; only the target's actual presented media frame can.
  const seekVideo = (t, observeExact) => {
    const intendedFrame = Math.min(FPS * DURATION - 1, Math.floor(Math.max(0, t) * FPS + 1e-6));
    const target = (intendedFrame + 0.5) / FPS;
    // One shared list retains at most64 source operations and128 callback rows.
    // The legacy exact list references the same exact records, without copies.
    // Each active operation also keeps last8 callbacks for its private timeout,
    // even after either global retention cap; no new media callbacks are armed.
    const observation = { kind: observeExact ? 'exact' : 'nonexact', requestedT: finite(t), intendedFrame, target,
      startedAt: performance.now(), currentTimeBefore: finite(video.currentTime),
      entry: { paused: video.paused, seeking: video.seeking, readyState: video.readyState,
        qualifiedTarget: finite(qualifiedExactTarget), currentTime: finite(video.currentTime),
        targetDelta: finite(video.currentTime - target) }, callbacks: [], seeked: false, cacheDecision: 'miss' };
    lastRequestedTarget = target;
    const retained = facts.sourcePresentations.length < 64;
    if(retained)facts.sourcePresentations.push(observation);else facts.sourcePresentationOverflow++;
    if(observeExact){if(retained)facts.exactPresentations.push(observation);else facts.exactPresentationOverflow++;}
    // This known zero-origin30CFR reference reuses only an actually qualified
    // target while paused. Getter microsecond reconstruction can differ from
    // the midpoint; its source-frame identity is only a consistency check, not
    // presentation authority or a rule for generic/VFR authored documents.
    if (video.paused && !video.seeking && video.readyState >= 2 && qualifiedExactTarget === target
      && Number.isFinite(video.currentTime) && video.currentTime >= 0
      && Math.floor(video.currentTime * FPS + 1e-6) === intendedFrame) {
      observation.cacheDecision='hit';observation.qualifiedPausedCache=true;observation.completedAt=performance.now();
      return Promise.resolve(video);
    }
    qualifiedExactTarget = null;
    return new Promise((resolve, reject) => {
      let handle, seeked = false, presented = false, settled = false;
      const recentCallbacks=[];
      const cleanup = () => { settled = true; clearTimeout(timer); video.removeEventListener('seeked', onSeeked); video.removeEventListener('error', onError); if (handle != null) video.cancelVideoFrameCallback(handle); };
      const finish = () => { if (seeked && presented) { qualifiedExactTarget = target;observation.completedAt=performance.now();observation.currentTimeAfter=finite(video.currentTime);cleanup(); resolve(video); } };
      const onSeeked = () => { seeked = true;observation.seeked=true;observation.seekedAt=performance.now();finish(); };
      const onError = () => { cleanup(); reject(Error('Authored source seek failed')); };
      const timer = setTimeout(() => {
        observation.timedOut=true;
        const summary={kind:observation.kind,requestedT:observation.requestedT,intendedFrame,target,
          entry:observation.entry,cacheDecision:observation.cacheDecision,seeked,
          currentTime:finite(video.currentTime),invalidation:facts.cacheInvalidations,
          callbacks:recentCallbacks.slice(),callbackRowsOmitted:0};
        let detail=JSON.stringify(summary);
        while(detail.length>2000&&summary.callbacks.length){summary.callbacks.shift();summary.callbackRowsOmitted++;detail=JSON.stringify(summary);}
        cleanup();reject(Error(`Authored presented-frame seek deadline ${detail}`));
      }, 1500);
      const arm = () => { handle = video.requestVideoFrameCallback((_at, metadata) => {
        handle = null;
        if (settled) return;
        const mediaTime=metadata?.mediaTime, sourceFrame=Math.round(mediaTime*FPS), ptsError=Math.abs(mediaTime-intendedFrame/FPS);
        // This reference requires the known zero-origin30CFR WebM source. Its
        // millisecond PTS quantization must not be compared to a frame midpoint.
        // Integer frame identity rejects neighboring frames even at boundaries.
        const qualified=Number.isFinite(mediaTime)&&mediaTime>=0&&sourceFrame===intendedFrame&&ptsError<=.001+1e-9;
        const row={at:performance.now(),mediaTime:finite(mediaTime),sourceFrame:finite(sourceFrame),ptsError:finite(ptsError),qualified,seeked};
        if(recentCallbacks.length>=8)recentCallbacks.shift();recentCallbacks.push(row);
        if(retained&&facts.sourceCallbackCount<128){
          facts.sourceCallbackCount++;if(observeExact)facts.exactCallbackCount++;
          if(observation.callbacks.length>=8)observation.callbacks.shift();observation.callbacks.push(row);
        }else{facts.sourceCallbackOverflow++;if(observeExact)facts.exactCallbackOverflow++;}
        if (!qualified) { arm(); return; }
        presented = true; finish();
      }); };
      video.addEventListener('seeked', onSeeked); video.addEventListener('error', onError);
      arm(); video.currentTime = target;
    });
  };
  const source = async (_scene, t, observeExact = false) => {
    await ready;
    if (disposed) throw Error('Authored disposed');
    return seekVideo(t, observeExact);
  };
  const publish = (songTime, t, _mediaScene, drawable, _state, valid) => {
    if (disposed || !drawable || !images) throw Error('Authored resources unavailable');
    const scene = sceneAt(songTime);
    // All drawing is detached. No await, visible clear, or partial front draw.
    backContext.reset();
    backContext.fillStyle = '#000'; backContext.fillRect(0, 0, W, H);
    const scale = 1.02, width = W * scale, height = H * scale;
    backContext.drawImage(drawable, (W - width) / 2, (H - height) / 2, width, height);
    backContext.drawImage(images[scene.badge], W - 288, 40, 240, 80);
    backContext.strokeStyle = scene.badge ? '#ffb15f' : '#39e7c2'; backContext.lineWidth = 6;
    backContext.strokeRect(12, 12, W - 24, H - 24);
    if (!valid() || disposed) return false;
    globalThis.__portosFilmLook?.frame(Math.round(songTime * TIMELINE_FPS));
    globalThis.__portosTitleCard?.draw(songTime);
    frontContext.save();
    try { frontContext.resetTransform(); frontContext.globalAlpha = 1; frontContext.globalCompositeOperation = 'copy'; frontContext.filter = 'none'; frontContext.drawImage(back, 0, 0); }
    finally { frontContext.restore(); }
    facts.completeCommits++;
    if (lastScene !== scene.sceneId) { if (lastScene !== null) facts.sceneTransitions++; lastScene = scene.sceneId; if (!facts.sceneIds.includes(lastScene)) facts.sceneIds.push(lastScene); }
    facts.lastCommit = { songTime, drawTime: t, sceneId: scene.sceneId, sourceTime: drawable.currentTime, at: performance.now() };
    return true;
  };
  // The scheduler is packaged explicitly by this custom author. Host admission
  // must come from the declaration+API, never canonical engine recognition.
  globalThis.portosComposition = {};
  installScheduler({ ready, duration: DURATION, fps: FPS, state: stateAt, scene: () => mediaScene, source,
    needsSource: () => true, videos: () => [video], publish,
    playback: on => globalThis.__portosFilmLook?.playback(on),
    dispose() { disposed = true; facts.disposed = true; video.pause(); video.removeAttribute('src'); video.load(); back.width = 0; back.height = 0; },
  });
  const scheduler = globalThis.portosComposition.previewPlayback;
  const reply = async (method, input) => {
    const value = await scheduler[method](input);
    if (method === 'prepare') {
      if (value.status !== 'prepared') throw Error('Authored preparation superseded');
      return { epoch: value.epoch, sequence: input.sequence, status: value.status, t: value.t };
    }
    const output = { epoch: value.epoch, sequence: input.sequence, status: value.status };
    if (method === 'sync' && Number.isFinite(value.driftSec)) output.driftSec = value.driftSec;
    return output;
  };
  const api = { version: 1, fps: FPS, presentation: 'atomic-canvas-v1', mediaTiming: 'staged-output-v1',
    clock: () => scheduler.clock(),
    prepare: input => reply('prepare', input), play: input => reply('play', input), sync: input => reply('sync', input),
    async pause(input) { exactLease++; const value = await scheduler.pause(input); await Promise.allSettled([...exactWork]); return value; },
    async dispose() { exactLease++; await Promise.allSettled([...exactWork]); return scheduler.dispose(); },
  };
  globalThis.portosComposition = { fps: TIMELINE_FPS, width: W, height: H, durationSec: DURATION, previewPlayback: api,
    seek(t) {
      const token = ++exactLease;
      const previous = [...exactWork];
      const operation = (async () => {
        await Promise.allSettled(previous); await ready;
        if (disposed || token !== exactLease) return;
        video.pause();
        const time = Math.max(0, Math.min(DURATION - 1 / FPS, Number(t)));
        if (!Number.isFinite(time)) throw Error('Authored exact seek time');
        const drawable = await source(mediaScene, time, true);
        if (token !== exactLease || disposed) return;
        globalThis.__portosFilmLook?.playback(false);
        publish(time, time, mediaScene, drawable, stateAt(time), () => token === exactLease && !disposed);
        facts.exactSeeks++;
      })();
      exactWork.add(operation); operation.then(() => exactWork.delete(operation), () => exactWork.delete(operation));
      return operation;
    },
  };
}
