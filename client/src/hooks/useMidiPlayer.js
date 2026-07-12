import { useCallback, useEffect, useRef, useState } from 'react';
import { createMidiPlayer } from '../lib/midiPlayback.js';

// React wrapper over lib/midiPlayback.js for the MIDI visualization (#2490):
// owns one player per parsed view-model, exposes play/pause + seek + a stable
// getPosition for the <MidiPianoRoll> rAF playhead, and tears the player down
// when the data changes or the host unmounts so oscillators never outlive the
// file they preview. No audio is touched until the first toggle — the player
// only reaches for the AudioContext inside play().

/**
 * @param {object|null} data — parseMidiFile view-model (null while loading/collapsed).
 * @returns {{ playing:boolean, toggle:()=>void, seek:(sec:number)=>void,
 *   getPosition:()=>number }}
 */
export default function useMidiPlayer(data) {
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef(null);

  useEffect(() => {
    if (!data) return undefined;
    const player = createMidiPlayer(data, { onEnded: () => setPlaying(false) });
    playerRef.current = player;
    return () => {
      player.stop();
      playerRef.current = null;
      setPlaying(false);
    };
  }, [data]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.isPlaying()) {
      player.pause();
      setPlaying(false);
    } else {
      setPlaying(true);
      // play() resolves once playback has STARTED; a resume failure (autoplay
      // policy edge) lands here — reset the button instead of lying "playing".
      player.play().catch((err) => {
        console.error(`🎹 MIDI preview failed to start: ${err.message}`);
        setPlaying(false);
      });
    }
  }, []);

  const seek = useCallback((sec) => { playerRef.current?.seek(sec); }, []);
  const getPosition = useCallback(() => playerRef.current?.position() ?? 0, []);

  return { playing, toggle, seek, getPosition };
}
