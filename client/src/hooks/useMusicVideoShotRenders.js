import { useEffect, useMemo, useRef, useState } from 'react';
import socket from '../services/socket';
import { getMusicVideoShotRenders } from '../services/apiMusicVideo.js';

// The project fields that can change which cached shot segments are current.
const renderInputs = (project) => JSON.stringify([project?.scenes, project?.filmLook, project?.composition, project?.statsOutro, project?.creditsOutro, project?.trackId, project?.lyricCues, project?.renderHistoryId]);

// Entering 'rendering' stamps the entry with its clock tick. Progress of the same attempt keeps that tick: an event
// carries the server's startedAt, which names the attempt; without one (older servers, optimistic starts) the tick
// is kept only while progress moves forward, so a replacement render that starts over is stamped anew.
const withRenderStart = (prev, sceneId, entry, stamp) => {
  if (entry?.state !== 'rendering') return entry;
  const before = prev[sceneId];
  if (before?.state !== 'rendering') return { ...entry, since: stamp };
  const sameAttempt = entry.startedAt !== undefined
    ? before.startedAt === entry.startedAt
    : (entry.progress ?? 0) >= (before.progress ?? 0);
  return { ...entry, since: sameAttempt ? before.since : stamp };
};

/**
 * The composed final render's per-shot cache state (`GET /:id/shot-renders`):
 * read when the project's render inputs change (debounced, as edits land) and
 * when a shot render settles, plus each shot's live render from the
 * `music-video:shot-render` events. Returns `{ status, live, markLive, clearLive, refresh, retry }`,
 * `live` keyed by sceneId (`{ state, progress, error, since, startedAt?, optimistic? }`). Off (null) for other render styles.
 */
export default function useMusicVideoShotRenders(project) {
  const projectId = project?.id;
  const composed = project?.composition?.mode === 'composed';
  const inputs = useMemo(() => renderInputs(project), [project]);
  const [status, setStatus] = useState(null);
  const [live, setLive] = useState({});
  const generation = useRef(0);
  // Logical clock for live entries and read issue times: ticks are unique, so "entered before this read" is strict.
  const clock = useRef(0);
  const liveRef = useRef(live);
  liveRef.current = live;

  // Drops 'rendering' entries the server does not list, when they entered before the read was issued.
  // Entries stamped later are a newer render the read cannot have seen. An optimistic entry (from a Render click)
  // is not dropped until a socket 'rendering' event confirms its scene, since the server may not have it yet.
  const dropStaleRendering = (fresh, issuedAt) => {
    const serverRendering = new Set((fresh.shots || []).filter((shot) => shot.rendering).map((shot) => shot.sceneId));
    setLive((prev) => {
      let next = null;
      for (const [sceneId, entry] of Object.entries(prev)) {
        if (entry.state !== 'rendering' || entry.optimistic || entry.since > issuedAt || serverRendering.has(sceneId)) continue;
        next ??= { ...prev };
        delete next[sceneId];
      }
      return next ?? prev;
    });
  };

  // Resolves to the fresh status, or null when this read was superseded or failed.
  const refresh = useRef(null);
  refresh.current = () => {
    const ticket = ++generation.current;
    const issuedAt = ++clock.current;
    return getMusicVideoShotRenders(projectId, { silent: true })
      .then((next) => {
        if (ticket !== generation.current) return null;
        setStatus(next);
        if (next && !next.error) dropStaleRendering(next, issuedAt);
        return next;
      })
      .catch((err) => {
        if (ticket === generation.current) {
          setStatus({
            available: true,
            error: { message: err?.message || (typeof err === 'string' ? err : 'Failed to read shot render status') },
            shots: [],
            outro: null,
            ready: 0,
            total: 0,
          });
        }
        return null;
      });
  };

  useEffect(() => {
    generation.current += 1;
    setStatus(null);
    if (!projectId || !composed) return undefined;
    const timer = setTimeout(() => refresh.current(), 600);
    return () => {
      clearTimeout(timer);
      generation.current += 1;
    };
  }, [projectId, composed, inputs]);

  useEffect(() => {
    setLive({});
    if (!projectId || !composed) return undefined;
    const onEvent = (event) => {
      if (event?.projectId !== projectId || !event.sceneId) return;
      const stamp = ++clock.current;
      setLive((prev) => {
        const next = { ...prev };
        if (event.state === 'rendering' || event.state === 'failed') next[event.sceneId] = withRenderStart(prev, event.sceneId, event, stamp);
        else delete next[event.sceneId];
        return next;
      });
      if (event.state !== 'rendering') refresh.current();
    };
    socket.on('music-video:shot-render', onEvent);
    // A terminal event sent while the socket was down is never replayed, and a server restart
    // kills the render outright: re-read on reconnect (the read reconciles stale live entries).
    let active = true;
    const onConnect = () => {
      if (active) refresh.current();
    };
    socket.on('connect', onConnect);
    return () => {
      active = false;
      socket.off('music-video:shot-render', onEvent);
      socket.off('connect', onConnect);
    };
  }, [projectId, composed]);

  const markLive = (sceneId, entry) => {
    const stamp = ++clock.current;
    setLive((prev) => {
      const next = { ...prev };
      if (entry) next[sceneId] = withRenderStart(prev, sceneId, { ...entry, optimistic: true }, stamp);
      else delete next[sceneId];
      return next;
    });
  };

  // Clears only the entry still carrying this render-start marker, so a late response can't wipe a newer render.
  // Returns whether it cleared that entry.
  const clearLive = (sceneId, since) => {
    if (since === undefined || liveRef.current[sceneId]?.since !== since) return false;
    setLive((prev) => {
      if (prev[sceneId]?.since !== since) return prev;
      const next = { ...prev };
      delete next[sceneId];
      return next;
    });
    return true;
  };

  return {
    status,
    live,
    markLive,
    clearLive,
    refresh: () => refresh.current(),
    retry: () => refresh.current(),
  };
}
