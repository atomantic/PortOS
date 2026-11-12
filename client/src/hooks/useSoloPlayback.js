import { useEffect, useMemo, useRef } from 'react';

// The players on the page that agreed to play one at a time.
const players = new Set();

/**
 * One player at a time among the players that join, for a page that shows two
 * which would sound together (the docked preview and the Blender film panel's
 * shot player both play the song). `pause()` stops this player.
 *
 * Returns `{ started, stopped, busy }`, stable across renders: call
 * `started()` when this player begins playing (every other joined player that
 * is playing is paused), `stopped()` when it pauses or ends, and `busy()` to
 * ask whether another one is playing now, so a player that starts by itself
 * can hold off instead of taking over.
 */
export default function useSoloPlayback(pause) {
  const pauseRef = useRef(pause);
  pauseRef.current = pause;
  const player = useRef(null);
  if (!player.current) player.current = { playing: false, pause: () => pauseRef.current?.() };
  useEffect(() => {
    const self = player.current;
    players.add(self);
    return () => {
      players.delete(self);
      self.playing = false;
    };
  }, []);
  return useMemo(() => {
    const self = player.current;
    return {
      started() {
        self.playing = true;
        for (const other of players) {
          if (other === self || !other.playing) continue;
          other.playing = false;
          other.pause();
        }
      },
      stopped() { self.playing = false; },
      busy: () => [...players].some((other) => other !== self && other.playing),
    };
  }, []);
}
