/**
 * Music Video — a compact, prompt-ready digest of a song's audio→MIDI transcription: its parts, likely key, and per-span density, low hits, top-line contour, chords and part entrances.
 *
 * The beat/energy analysis (audioAnalysis.js) tells a planning model WHEN the
 * song moves and how loud it is; the transcription adds WHAT plays: which
 * instruments carry a passage, where a bass or drum hit lands, whether the top
 * line climbs or falls, where the harmony turns and where a part enters or
 * drops out. Those are the cues an editor cuts on, so the planner and the
 * Cast & Sets direction quote them per shot and per section.
 *
 * Pure: takes the `parseMidiFile` view-model (server/lib/midiFile.js) and
 * returns plain text facts, bounded in length, with times in song seconds.
 * A transcription is a machine guess, so every line says it came from one.
 */

import { detectChordWindows } from '../midiChords.js';
import { PITCH_CLASS_NAMES, midiNoteName, pitchClass } from '../pitchNames.js';

// General MIDI program families, program / 8.
const GM_FAMILIES = ['piano', 'chromatic percussion', 'organ', 'guitar', 'bass', 'strings', 'ensemble', 'brass',
  'reed', 'pipe', 'synth lead', 'synth pad', 'synth effects', 'ethnic', 'percussive', 'sound effects'];
// Below C3 a pitched part reads as the low end.
const LOW_MIDI = 48;
// A part with fewer notes is transcription noise, not an entrance.
const MIN_PART_NOTES = 4;
const MAX_LISTED = 4;
const MIN_CHORD_SEC = 0.25;

const round1 = (n) => Math.round(n * 10) / 10;
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

// Krumhansl-Kessler key profiles (major, minor), tonic first.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const correlate = (a, b) => {
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
};

/** The likeliest key of duration-weighted pitched notes, or null when no profile fits well. */
function guessKey(notes) {
  const histogram = new Array(12).fill(0);
  for (const n of notes) histogram[pitchClass(n.midi)] += n.durationSec;
  if (!histogram.some((v) => v > 0)) return null;
  let best = null;
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const rotated = histogram.map((_, i) => histogram[(i + tonic) % 12]);
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
      const r = correlate(rotated, profile);
      if (!best || r > best.r) best = { r, name: `${PITCH_CLASS_NAMES[tonic]} ${mode}` };
    }
  }
  return best.r >= 0.5 ? best.name : null;
}

function partRole(track, notes) {
  const name = String(track.name || '');
  if (track.drums || /drum|perc|kit/i.test(name)) return 'drums';
  if (/bass/i.test(name) || (track.program != null && Math.floor(track.program / 8) === 4)) return 'bass';
  return median(notes.map((n) => n.midi)) < LOW_MIDI ? 'bass' : 'pitched';
}

function partLabel(track, role) {
  const name = String(track.name || '').trim();
  if (name) return name.slice(0, 40).toLowerCase();
  if (role !== 'pitched') return role;
  return track.program != null ? GM_FAMILIES[Math.floor(track.program / 8)] : 'melodic part';
}

/**
 * Index a parsed transcription for prompt facts. `parsed` is `parseMidiFile`'s
 * view-model. Returns null when it holds no notes.
 */
export function buildMidiDigest(parsed) {
  const notes = Array.isArray(parsed?.notes) ? parsed.notes.filter((n) => Number.isFinite(n.startSec) && Number.isFinite(n.midi)) : [];
  if (!notes.length) return null;
  const byTrack = new Map();
  for (const n of notes) {
    if (!byTrack.has(n.track)) byTrack.set(n.track, []);
    byTrack.get(n.track).push(n);
  }
  const tracks = new Map((parsed.tracks || []).map((t) => [t.index, t]));
  const parts = [...byTrack.entries()].map(([index, list]) => {
    const track = tracks.get(index) || { index };
    const role = partRole(track, list);
    const midis = list.map((n) => n.midi);
    return {
      track: index, role, label: partLabel(track, role), noteCount: list.length,
      low: Math.min(...midis), high: Math.max(...midis),
      firstSec: list[0].startSec, lastSec: Math.max(...list.map((n) => n.startSec + n.durationSec)),
    };
  }).sort((a, b) => b.noteCount - a.noteCount);
  // Two parts with one label read as one instrument in the facts.
  const seen = new Map();
  for (const part of parts) {
    const count = (seen.get(part.label) || 0) + 1;
    seen.set(part.label, count);
    if (count > 1) part.label = `${part.label} ${count}`;
  }
  const roleOf = new Map(parts.map((p) => [p.track, p.role]));
  const tagged = notes.map((n) => ({ ...n, role: roleOf.get(n.track) }));
  const pitched = tagged.filter((n) => n.role !== 'drums');
  const durationSec = Math.max(parsed.durationSec || 0, ...tagged.map((n) => n.startSec + n.durationSec));
  const hitFloor = Math.max(0.7, quantile(tagged.map((n) => n.velocity ?? 0), 0.9) ?? 0.7);
  return {
    durationSec,
    notesPerSec: durationSec > 0 ? tagged.length / durationSec : 0,
    key: guessKey(pitched),
    parts,
    notes: tagged,
    // Strong onsets in the low end or the kit: impacts, kicks and bass stabs to cut on.
    hits: tagged.filter((n) => (n.role === 'drums' || n.role === 'bass' || n.midi < LOW_MIDI) && (n.velocity ?? 0) >= hitFloor)
      .map((n) => n.startSec),
    // Named chords only: a bare pitch list is a voicing the namer could not place.
    chords: detectChordWindows(pitched).filter((c) => !c.label.includes(' ') && c.endSec - c.startSec >= MIN_CHORD_SEC),
  };
}

/** One line on the whole transcription, for the top of a planning prompt. */
export function midiSongSummary(digest) {
  if (!digest) return '';
  const parts = digest.parts.filter((p) => p.noteCount >= MIN_PART_NOTES).slice(0, 8)
    .map((p) => `${p.label} (${midiNoteName(p.low)}–${midiNoteName(p.high)}, ${round1(p.firstSec)}–${round1(p.lastSec)}s)`);
  return [
    `Audio-to-MIDI transcription of the song (a machine estimate; trust the beat analysis for timing): ${parts.length} part${parts.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join('; ')}` : ''}`,
    digest.key && `likely key ${digest.key}`,
    `${round1(digest.notesPerSec)} notes per second overall`,
  ].filter(Boolean).join('; ');
}

const dedupeTimes = (times, gapSec = 0.15) => times.reduce((out, t) => {
  if (!out.length || t - out[out.length - 1] >= gapSec) out.push(round1(t));
  return out;
}, []);

function densityWord(ratio) {
  if (ratio < 0.35) return 'sparse';
  if (ratio < 0.8) return 'lighter than average';
  if (ratio < 1.25) return 'average density';
  if (ratio < 1.8) return 'busy';
  return 'very busy';
}

function topLine(notes, startSec, endSec) {
  const melodic = notes.filter((n) => n.role === 'pitched');
  if (melodic.length < 3) return '';
  const mid = (startSec + endSec) / 2;
  const top = (list) => median(list.map((n) => n.midi));
  // The top voice: the highest note sounding at each onset.
  const onsets = new Map();
  for (const n of melodic) onsets.set(n.startSec, Math.max(onsets.get(n.startSec) ?? -1, n.midi));
  const line = [...onsets.entries()].map(([t, midi]) => ({ startSec: t, midi }));
  const first = top(line.filter((n) => n.startSec < mid));
  const last = top(line.filter((n) => n.startSec >= mid));
  const low = Math.min(...line.map((n) => n.midi));
  const high = Math.max(...line.map((n) => n.midi));
  if (first == null || last == null) return `top line ${midiNoteName(low)}–${midiNoteName(high)}`;
  const shape = last - first >= 3 ? 'rising' : first - last >= 3 ? 'falling' : 'level';
  return `top line ${shape} (${midiNoteName(first)} to ${midiNoteName(last)}, range ${midiNoteName(low)}–${midiNoteName(high)})`;
}

/**
 * What the transcription shows inside `[startSec, endSec)` as one line of
 * facts, or '' when the digest is missing or the span is empty.
 */
export function midiWindowFacts(digest, startSec, endSec) {
  if (!digest || !(endSec > startSec)) return '';
  const inside = digest.notes.filter((n) => n.startSec >= startSec && n.startSec < endSec);
  const span = endSec - startSec;
  if (!inside.length) {
    const held = digest.notes.some((n) => n.startSec < startSec && n.startSec + n.durationSec > startSec);
    return held ? 'transcription: no new notes, a held sound carries over' : 'transcription: no notes (a break or an untranscribed sound)';
  }
  const ratio = digest.notesPerSec > 0 ? (inside.length / span) / digest.notesPerSec : 1;
  const parts = new Map(digest.parts.map((p) => [p.track, p]));
  const playing = [...new Set(inside.map((n) => n.track))].map((t) => parts.get(t)).filter((p) => p && p.noteCount >= MIN_PART_NOTES);
  const enters = playing.filter((p) => p.firstSec >= startSec && p.firstSec < endSec && p.firstSec > 0.5).map((p) => p.label);
  const exits = digest.parts.filter((p) => p.noteCount >= MIN_PART_NOTES && p.lastSec >= startSec && p.lastSec < endSec && p.lastSec < digest.durationSec - 2).map((p) => p.label);
  const hits = dedupeTimes(digest.hits.filter((t) => t >= startSec && t < endSec));
  const chords = digest.chords.filter((c) => c.endSec > startSec && c.startSec < endSec)
    .map((c) => c.label).filter((label, i, all) => label !== all[i - 1]);
  return [
    `transcription: ${densityWord(ratio)} (${round1(inside.length / span)} notes/s)`,
    playing.length && `playing: ${playing.slice(0, MAX_LISTED).map((p) => p.label).join(', ')}`,
    hits.length && `strong low hits at ${hits.slice(0, MAX_LISTED).join(', ')}s${hits.length > MAX_LISTED ? ` (+${hits.length - MAX_LISTED} more)` : ''}`,
    topLine(inside, startSec, endSec),
    chords.length && `chords ${chords.slice(0, MAX_LISTED).join(' → ')}${chords.length > MAX_LISTED ? ' …' : ''}`,
    enters.length && `enters: ${enters.join(', ')}`,
    exits.length && `drops out: ${exits.join(', ')}`,
  ].filter(Boolean).join('; ');
}
