import { useEffect, useMemo, useRef, useState } from 'react';
import socket from '../services/socket';
import { getMusicVideoShotRenders } from '../services/apiMusicVideo.js';

// The project fields that can change which cached shot segments are current.
const renderInputs = (project) => JSON.stringify([project?.scenes, project?.filmLook, project?.composition, project?.statsOutro, project?.creditsOutro, project?.trackId, project?.lyricCues, project?.renderHistoryId]);

/**
 * The composed final render's per-shot cache state (`GET /:id/shot-renders`):
 * read when the project's render inputs change (debounced, as edits land) and
 * when a shot render settles, plus each shot's live render from the
 * `music-video:shot-render` events. Returns `{ status, live }`, `live` keyed
 * by sceneId (`{ state, progress, error }`). Off (null) for other render styles.
 */
export default function useMusicVideoShotRenders(project) {
  const projectId = project?.id;
  const composed = project?.composition?.mode === 'composed';
  const inputs = useMemo(() => renderInputs(project), [project]);
  const [status, setStatus] = useState(null);
  const [live, setLive] = useState({});
  const generation = useRef(0);

  const refresh = useRef(null);
  refresh.current = () => {
    const ticket = ++generation.current;
    getMusicVideoShotRenders(projectId, { silent: true })
      .then((next) => { if (ticket === generation.current) setStatus(next); })
      .catch(() => {});
  };

  useEffect(() => {
    if (!projectId || !composed) { generation.current += 1; setStatus(null); return undefined; }
    const timer = setTimeout(() => refresh.current(), 600);
    return () => clearTimeout(timer);
  }, [projectId, composed, inputs]);

  useEffect(() => {
    setLive({});
    if (!projectId || !composed) return undefined;
    const onEvent = (event) => {
      if (event?.projectId !== projectId || !event.sceneId) return;
      setLive((prev) => {
        const next = { ...prev };
        if (event.state === 'rendering' || event.state === 'failed') next[event.sceneId] = event;
        else delete next[event.sceneId];
        return next;
      });
      if (event.state !== 'rendering') refresh.current();
    };
    socket.on('music-video:shot-render', onEvent);
    return () => socket.off('music-video:shot-render', onEvent);
  }, [projectId, composed]);

  const markLive = (sceneId, entry) => setLive((prev) => {
    const next = { ...prev };
    if (entry) next[sceneId] = entry;
    else delete next[sceneId];
    return next;
  });
  return { status, live, markLive, refresh: () => refresh.current() };
}
