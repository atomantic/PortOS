// Song-time clock. The chosen anchor defines bar 1, independently of the first tracked beat.
import { clamp, lerp } from './core.js';

export function makeSong(mv, { anchorSec, beatsPerBar = 4 } = {}) {
  const song = mv?.song || {};
  const beats = (song.beats || []).slice();
  const period = beats.length > 1 ? (beats.at(-1) - beats[0]) / (beats.length - 1) : 60 / (song.bpm || 120);
  if (!beats.length) beats.push(0);
  const first = beats[0], last = beats.length - 1;
  const beatTime = (i) => {
    if (i <= 0) return first + i * period;
    if (i >= last) return beats[last] + (i - last) * period;
    const k = Math.floor(i);
    return lerp(beats[k], beats[k + 1], i - k);
  };
  const beatAt = (t) => {
    if (t <= first) return (t - first) / period;
    if (t >= beats[last]) return last + (t - beats[last]) / period;
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid] <= t) lo = mid; else hi = mid; }
    return lo + (t - beats[lo]) / (beats[lo + 1] - beats[lo]);
  };
  const anchor = anchorSec ?? song.downbeats?.[0] ?? first;
  const anchorBeat = beatAt(anchor);
  const barTime = (n, beat = 0) => beatTime(anchorBeat + (n - 1) * beatsPerBar + beat);
  const barAt = (t) => (beatAt(t) - anchorBeat) / beatsPerBar + 1;
  const env = song.features?.envelopes;
  const peaks = {};
  const level = (band, t) => {
    const list = env?.[band];
    if (!list?.length || !env.fps) return 0;
    if (!peaks[band]) peaks[band] = list.reduce((max, value) => Math.max(max, value), 1e-6);
    const x = clamp(t, 0, (list.length - 1) / env.fps) * env.fps;
    const k = Math.floor(x);
    return lerp(list[k], list[Math.min(list.length - 1, k + 1)], x - k) / peaks[band];
  };
  const swell = (band, t, window = 2) => {
    let sum = 0;
    for (let i = 0; i < 9; i += 1) sum += level(band, t + (i / 8 - 0.5) * window);
    return sum / 9;
  };
  const pulse = (t, decay = 5) => { const b = beatAt(t); return Math.exp(-(b - Math.floor(b)) * decay); };
  return { beats, period, anchorSec: anchor, beatsPerBar, durationSec: mv?.render?.durationSec || song.durationSec || 16, beatTime, beatAt, barTime, barAt, level, swell, pulse };
}
