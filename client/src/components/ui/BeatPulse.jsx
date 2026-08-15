/**
 * BeatPulse — the metronome you can SEE: one dot per beat of the bar, the
 * current one lit.
 *
 * Three surfaces draw this same row (the song `Metronome`, and the SongBook
 * drum + chord play-along transports). They each grew their own copy and had
 * already drifted on lit color and dot size, so the widget lives here once and
 * every host renders it. Rendering only the dots is deliberate: each host pairs
 * them with a different readout ("Bar 3", "2/8 bars", "5/12 chords"), so the
 * text stays with the host.
 *
 * What the copies already agreed on and this keeps: a count-in beat lights amber
 * (`port-warning`) so "not yet" is unmistakable, and unlit dots are
 * `port-border`, the same weight as any inert chrome. Newly canonical for every
 * surface: beat 1 is drawn a size larger, matching the accented click — the
 * Metronome had that downbeat accent and the transports didn't.
 *
 * `beat` is 1-based and nullish/`0` when stopped — the audible click is easy to
 * lose under a backing track, so "nothing lit" has to read as stopped. Hosts
 * therefore pass `pulse?.beat` straight through: the nullish/boolean coercion
 * lives here once rather than being re-typed at every call site.
 */

import { normalizeBeatsPerBar } from '../../lib/metronome.js';

// Lit dots are `port-success`, not `port-accent`: in the transport bars the
// accent color already means "this control is engaged" (`activeCtrlClass`), and
// a beat dot borrowing it competed with the play button. Green reads as
// "sounding now" and stays clearly distinct from the amber count-in.
const litTone = (countingIn) => (countingIn ? 'bg-port-warning' : 'bg-port-success');

export default function BeatPulse({ beatsPerBar, beat = null, countingIn = false }) {
  // Same normalization the scheduler applies, so a garbled `time:` header can't
  // leave the dots disagreeing with the clicks.
  const beats = normalizeBeatsPerBar(beatsPerBar);
  const label = countingIn
    ? `Counting in, beat ${beat || 1}`
    : (beat ? `Beat ${beat}` : 'Stopped');

  return (
    <div
      className="flex items-center gap-1.5"
      role="status"
      aria-live="off"
      aria-label={label}
    >
      {Array.from({ length: beats }, (_, i) => {
        const lit = beat === i + 1;
        const downbeat = i === 0;
        return (
          <span
            key={i}
            aria-hidden="true"
            className={`rounded-full transition-transform duration-75 ${
              downbeat ? 'w-3 h-3' : 'w-2 h-2'
            } ${lit ? litTone(countingIn) : 'bg-port-border'} ${lit ? 'scale-125' : 'scale-100'}`}
          />
        );
      })}
    </div>
  );
}
