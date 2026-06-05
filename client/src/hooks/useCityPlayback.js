import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { getCitySnapshots } from '../services/apiCity.js';
import { isPlayableFrame, buildPlaybackStats } from '../lib/cityPlaybackFrame.js';

// Transport state for the CyberCity timeline scrubber (issue #967). Owns the
// snapshot series, the current frame index, and play/pause/speed so CyberCity.jsx
// stays lean. Pure-UI: it reads the snapshot API and steps an index; the page
// turns the current frame into scene props via lib/cityPlaybackFrame.js.

export const PLAYBACK_SPEEDS = [1, 2, 4]; // × frames/sec
const BASE_INTERVAL_MS = 1000; // 1×: advance one frame per second

export function useCityPlayback() {
  const [active, setActive] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(PLAYBACK_SPEEDS[0]);
  const [loading, setLoading] = useState(false);
  // null = no error; true = the series fetch failed. Distinct from an empty
  // series (a real, fetched-empty history) so the overlay can say "couldn't
  // load" vs "nothing recorded yet" — the absent-vs-empty rule.
  const [error, setError] = useState(false);

  // Guards a deferred/interval callback against firing after unmount (CLAUDE.md
  // deferred-work rule). Never reset to true — handles dev double-mount cleanly.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const enter = useCallback(async () => {
    setActive(true);
    setLoading(true);
    setPlaying(false);
    setError(false);
    // Sentinel: catch → null marks a failed fetch, distinct from a fetched-empty
    // history. Validate the payload is actually an array before trusting it.
    const res = await getCitySnapshots({ silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!res || !Array.isArray(res.snapshots)) {
      setError(true);
      setSnapshots([]);
      setLoading(false);
      return;
    }
    // Only keep frames this scrubber can render (schemaVersion gate); a future
    // bump leaves older/newer frames out rather than mis-rendering them.
    const frames = res.snapshots.filter(isPlayableFrame);
    setSnapshots(frames);
    setFrameIndex(frames.length > 0 ? frames.length - 1 : 0); // start at "now"
    setLoading(false);
  }, []);

  const exit = useCallback(() => {
    setActive(false);
    setPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    // At the last frame, play restarts from the beginning.
    setPlaying((p) => {
      if (!p) setFrameIndex((i) => (i >= snapshots.length - 1 ? 0 : i));
      return !p;
    });
  }, [snapshots.length]);

  const cycleSpeed = useCallback(() => {
    setSpeed((s) => {
      const idx = PLAYBACK_SPEEDS.indexOf(s);
      return PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length];
    });
  }, []);

  // Clamped step; pauses if a manual step is taken while playing.
  const step = useCallback((delta) => {
    setPlaying(false);
    setFrameIndex((i) => Math.max(0, Math.min(snapshots.length - 1, i + delta)));
  }, [snapshots.length]);

  const seek = useCallback((index) => {
    setFrameIndex(() => Math.max(0, Math.min(snapshots.length - 1, index)));
  }, [snapshots.length]);

  // Auto-advance timer. Guarded by mountedRef and torn down on
  // pause/exit/speed-change/unmount so it never fires into the void. The updater
  // stays PURE — it only clamps the index forward; the "stop at the end" pause
  // is a separate effect below (calling a setter inside a state updater would
  // double-fire under StrictMode).
  useEffect(() => {
    if (!active || !playing || snapshots.length === 0) return undefined;
    const id = setInterval(() => {
      if (!mountedRef.current) return;
      setFrameIndex((i) => Math.min(i + 1, snapshots.length - 1));
    }, BASE_INTERVAL_MS / speed);
    return () => clearInterval(id);
  }, [active, playing, speed, snapshots.length]);

  // Pause when playback reaches the last frame (kept out of the interval's
  // updater so that updater stays a pure function of the previous index).
  useEffect(() => {
    if (playing && snapshots.length > 0 && frameIndex >= snapshots.length - 1) {
      setPlaying(false);
    }
  }, [playing, frameIndex, snapshots.length]);

  const currentFrame = snapshots[frameIndex] || null;
  const stats = useMemo(() => buildPlaybackStats(currentFrame), [currentFrame]);

  return {
    active, enter, exit,
    snapshots, frameIndex, currentFrame, stats, seek, step,
    playing, togglePlay,
    speed, cycleSpeed,
    loading, error,
    frameCount: snapshots.length,
  };
}
