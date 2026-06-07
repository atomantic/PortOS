/**
 * Metronome — start/stop tempo reference with count-in and a visual beat pulse.
 *
 * Drives client/src/lib/metronome.js (sample-accurate Web Audio scheduler). The
 * BPM defaults from the song `tempo`; the time signature is derived from the
 * score header (default 4/4). Beat 1 is accented both audibly (brighter click)
 * and visually (filled accent dot). The optional one-bar count-in lets a singer
 * find beat 1 before recording / color-match begins.
 *
 * Reads tempo + score from props already on the song record — issues no fetch of
 * its own. Tears the metronome down on stop and on unmount so a navigation-away
 * can't leave a timer or scheduled audio running.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Timer } from 'lucide-react';
import toast from '../ui/Toast';
import {
  createMetronome,
  clampBpm,
  timeSignatureFromScore,
  METRONOME_BPM_MIN,
  METRONOME_BPM_MAX,
  DEFAULT_BPM,
} from '../../lib/metronome.js';

export default function Metronome({ tempo = null, score = '', countInBars = 1 }) {
  const [bpm, setBpm] = useState(() => clampBpm(tempo) ?? DEFAULT_BPM);
  const [countIn, setCountIn] = useState(true);
  const [running, setRunning] = useState(false);
  const [pulse, setPulse] = useState(null); // { beat, bar, accent, countIn }
  const metroRef = useRef(null);

  // Time signature from the score header — the dot row mirrors beats-per-bar.
  const timeSig = useMemo(() => timeSignatureFromScore(score), [score]);
  const beatsPerBar = timeSig.beats;

  const teardown = useCallback(() => {
    if (metroRef.current) {
      metroRef.current.stop();
      metroRef.current = null;
    }
  }, []);

  // Stop the metronome on unmount (deferred-work cleanup).
  useEffect(() => teardown, [teardown]);

  const stop = useCallback(() => {
    teardown();
    setRunning(false);
    setPulse(null);
  }, [teardown]);

  const start = useCallback(async () => {
    teardown();
    const metro = createMetronome({
      bpm,
      beatsPerBar,
      beatValue: timeSig.beatValue,
      countInBars: countIn ? countInBars : 0,
      onBeat: (info) => setPulse(info),
    });
    metroRef.current = metro;
    setRunning(true);
    await metro.start().catch((err) => {
      toast.error(err?.message || 'Could not start the metronome');
      stop();
    });
  }, [teardown, bpm, beatsPerBar, timeSig.beatValue, countIn, countInBars, stop]);

  const onBpmChange = useCallback((value) => {
    const next = clampBpm(value);
    if (next == null) return;
    setBpm(next);
    if (metroRef.current) metroRef.current.setBpm(next);
  }, []);

  const dots = useMemo(() => Array.from({ length: beatsPerBar }, (_, i) => i + 1), [beatsPerBar]);
  const activeBeat = running && pulse ? pulse.beat : 0;

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Timer size={15} className="text-port-accent" /> Metronome
          <span className="text-xs font-normal text-gray-500">{timeSig.beats}/{timeSig.beatValue}</span>
        </h3>
        <div className="flex items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={stop}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-error text-white hover:bg-port-error/90"
            >
              <Square size={14} /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90"
            >
              <Play size={14} /> Start
            </button>
          )}
        </div>
      </div>

      {/* Visual beat pulse — one dot per beat; beat 1 is the accent. */}
      <div className="flex items-center gap-2 mt-3" aria-hidden="true">
        {dots.map((n) => {
          const isActive = n === activeBeat;
          const isAccent = n === 1;
          const tone = isActive
            ? (pulse?.countIn ? 'bg-port-warning' : 'bg-port-success')
            : 'bg-port-border';
          return (
            <span
              key={n}
              className={`rounded-full transition-transform duration-75 ${isAccent ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'} ${tone} ${isActive ? 'scale-125' : 'scale-100'}`}
            />
          );
        })}
        {running && (
          <span className="text-xs text-gray-500 ml-1">
            {pulse?.countIn ? 'Count-in…' : pulse?.bar ? `Bar ${pulse.bar}` : ''}
          </span>
        )}
      </div>

      <div className="flex items-end gap-4 mt-3 flex-wrap">
        <div>
          <label htmlFor="metronome-bpm" className="block text-xs text-gray-400 mb-1">Tempo (BPM)</label>
          <input
            id="metronome-bpm"
            type="number"
            inputMode="numeric"
            min={METRONOME_BPM_MIN}
            max={METRONOME_BPM_MAX}
            value={bpm}
            onChange={(e) => onBpmChange(e.target.value)}
            onBlur={() => onBpmChange(bpm)}
            className="w-24 bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
          />
        </div>
        <label htmlFor="metronome-countin" className="flex items-center gap-2 text-xs text-gray-400 pb-2 cursor-pointer">
          <input
            id="metronome-countin"
            type="checkbox"
            checked={countIn}
            onChange={(e) => setCountIn(e.target.checked)}
            className="accent-port-accent"
          />
          Count-in (one bar)
        </label>
      </div>
    </div>
  );
}
