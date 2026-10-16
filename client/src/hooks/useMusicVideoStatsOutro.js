import { useCallback, useEffect, useRef, useState } from 'react';
import { getMusicVideoOutroStats } from '../services/apiMusicVideo.js';

/**
 * The cutting room floor outro's clock (lib/musicVideoStatsOutro.js): `start()`
 * plays it for `seconds` on a clock of its own and fetches the tally afresh, so
 * it counts the latest choices; it holds on its last frame once it has run.
 * With `audioRef`, it also starts when that song ends. A different project or
 * length stops it. Returns `{ seconds, t, stats, active, paused, start, stop, pause }`
 * (`t` null while it is off screen).
 */
export default function useMusicVideoStatsOutro({ projectId, seconds, audioRef = null }) {
  const [t, setT] = useState(null);
  const [stats, setStats] = useState(null);
  const [paused, setPaused] = useState(false);
  const run = useRef({ handle: 0, startedAt: 0, generation: 0 });
  const stop = useCallback(() => {
    cancelAnimationFrame(run.current.handle);
    run.current.generation += 1;
    setT(null);
    setPaused(false);
  }, []);
  const pause = useCallback(() => { cancelAnimationFrame(run.current.handle); setPaused(true); }, []);
  const start = useCallback(() => {
    if (!(seconds > 0)) return;
    cancelAnimationFrame(run.current.handle);
    const generation = ++run.current.generation;
    run.current.startedAt = performance.now();
    setT(0);
    setPaused(false);
    getMusicVideoOutroStats(projectId, { silent: true })
      .then((next) => { if (run.current.generation === generation) setStats(next?.stats || null); })
      .catch(() => {});
    const tick = () => {
      if (run.current.generation !== generation) return;
      const elapsed = (performance.now() - run.current.startedAt) / 1000;
      setT(Math.min(elapsed, seconds));
      if (elapsed < seconds) run.current.handle = requestAnimationFrame(tick);
    };
    run.current.handle = requestAnimationFrame(tick);
  }, [seconds, projectId]);
  useEffect(() => { stop(); setStats(null); }, [projectId, seconds, stop]);
  useEffect(() => () => cancelAnimationFrame(run.current.handle), []);
  useEffect(() => {
    const audio = audioRef?.current;
    if (!audio || !(seconds > 0)) return undefined;
    audio.addEventListener('ended', start);
    return () => audio.removeEventListener('ended', start);
  }, [audioRef, seconds, start]);
  return { seconds, t, stats, active: t != null, paused, start, stop, pause };
}
