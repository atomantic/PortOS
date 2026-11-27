/** Resolve scene layers and drawable sources for atomic preview canvas publication. */
export function createPreviewPlaybackLayers(bridge, { now, owns }) {
  const stateAt = (t) => {
    const state = bridge.state(t);
    return { songTime: t, state, t: state.t, scene: bridge.scene(state.t) };
  };
  const videoOf = (item) => item?.scene?.media?.kind === 'video' && item.source ? item.source : null;
  // Which drawable a still needs at item.t (a photo sequence's current step);
  // null where one source serves the whole scene. A change is a transition.
  const keyOf = (item) => item?.scene && bridge.needsSource(item.scene) ? bridge.sourceKey?.(item.scene, item.t) ?? null : null;
  // Extra drawables a frame paints besides its source (a wipe's held outgoing
  // shot). An item whose layers no longer fit its time is reloaded like a step.
  const layersFit = (item) => !item?.scene || (bridge.layersReady?.(item.scene, item.t, item.layers ?? null) ?? true);
  // Autonomous media advances on song time, while narrative holds deliberately
  // freeze its source clock. Camera/code drawing still uses quantized item.t.
  const sourceClock = (item) => item.state.hold ? item.t : item.songTime;
  const sourceTarget = (item) => {
    const video = videoOf(item), media = item.scene.media;
    const end = Math.min(Number.isFinite(media.outSec) ? media.outSec : video.duration, video.duration);
    const last = Math.max(0, end - 0.5 / (media.fps || bridge.fps));
    return Math.min(Math.max((media.inSec || 0) + sourceClock(item) - item.scene.startSec, media.inSec || 0), last, Math.max(0, video.duration - 1e-3));
  };
  const endHold = (item) => {
    const video = videoOf(item);
    if (!video) return false;
    const end = Math.min(Number.isFinite(item.scene.media.outSec) ? item.scene.media.outSec : video.duration, video.duration);
    return Number.isFinite(end) && (item.scene.media.inSec || 0) + sourceClock(item) - item.scene.startSec >= end - 0.5 / (item.scene.media.fps || bridge.fps);
  };
  const load = async (t, token, live = false) => {
    const item = stateAt(t);
    const sourceTime = live && item.scene?.media?.kind === 'video' ? sourceClock(item) : item.t;
    // Layers first: a held layer draws from a source the incoming one may reuse.
    item.layers = item.scene ? await bridge.layers?.(item.scene, item.t) ?? null : null;
    if (!owns(token)) return null;
    item.source = item.scene && bridge.needsSource(item.scene) ? await bridge.source(item.scene, sourceTime) : null;
    if (!owns(token)) return null;
    item.sourceKey = keyOf(item);
    item.endHold = endHold(item);
    return item;
  };
  const freshSource = (aligned, latest, startedAt) => {
    const video = videoOf(aligned), item = { ...latest, source: aligned.source, sourceKey: aligned.sourceKey ?? null, layers: aligned.layers ?? null };
    const same = latest.scene === aligned.scene && latest.state.hold === aligned.state.hold
      && (!latest.state.hold || latest.t === aligned.t) && endHold(item) === endHold(aligned) && layersFit(item);
    const drift = video && latest.scene === aligned.scene ? video.currentTime - sourceTarget(item) : 0;
    return { item, drift, valid: same && now() - startedAt < 100
      && (!video || video.readyState >= 2 && !video.seeking && Number.isFinite(drift) && Math.abs(drift) < 0.1) };
  };
  const publish = (item, token, valid = () => true) => bridge.publish(item.songTime, item.t, item.scene, item.source, item.state,
    () => owns(token) && valid(), item.layers ?? null);
  const liveVideo = (item) => videoOf(item) && !item.state.hold && !item.endHold;
  const needsTransition = (active, next, nextEndHold) => !active || active.scene !== next.scene
    || active.state.hold !== next.state.hold || active.endHold !== nextEndHold
    || (active.sourceKey ?? null) !== keyOf(next) || !layersFit({ ...next, layers: active.layers });
  return { stateAt, videoOf, keyOf, layersFit, sourceTarget, endHold, load, freshSource, publish, liveVideo, needsTransition };
}
