import { useState, useRef, useCallback, useEffect } from 'react';
import { getCitySnapshots } from '../services/apiCity.js';
import { isPlayableFrame } from '../lib/cityPlaybackFrame.js';

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

  // Guards a deferred/interval callback against firing after unmount (CLAUDE.md
  // deferred-work rule). Never reset to true — handles dev double-mount cleanly.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const enter = useCallback(async () => {
    setActive(true);
    setLoading(true);
    setPlaying(false);
    const res = await getCitySnapshots({ silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    // Only keep frames this scrubber can render (schemaVersion gate); a future
    // bump leaves older/newer frames out rather than mis-rendering them.
    const frames = (res?.snapshots || []).filter(isPlayableFrame);
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

  // Auto-advance timer. Stops at the last frame. Guarded by mountedRef and torn
  // down on pause/exit/speed-change/unmount so it never fires into the void.
  useEffect(() => {
    if (!active || !playing || snapshots.length === 0) return undefined;
    const id = setInterval(() => {
      if (!mountedRef.current) return;
      setFrameIndex((i) => {
        if (i >= snapshots.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, BASE_INTERVAL_MS / speed);
    return () => clearInterval(id);
  }, [active, playing, speed, snapshots.length]);

  const currentFrame = snapshots[frameIndex] || null;

  return {
    active, enter, exit,
    snapshots, frameIndex, currentFrame, seek, step,
    playing, togglePlay,
    speed, cycleSpeed,
    loading,
    frameCount: snapshots.length,
  };
}
