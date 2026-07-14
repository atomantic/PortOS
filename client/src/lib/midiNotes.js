// Minimal Standard MIDI File (SMF) parser + normalizer for the MIDI
// visualization UI (<MidiVisualization> / <MidiPianoRoll>). Parses format 0/1
// files down to the events the piano-roll needs — note-on/off, tempo map,
// track names — and normalizes them into a stable view-model with absolute
// seconds. Pure byte math, no canvas/React/fetch, so it's unit-testable with
// hand-built fixture bytes. Intentionally in-tree (no MIDI dependency): the
// roll only needs notes + tempo, not CC lanes or sysex payloads.
//
// View-model shape (consumed by useMidiNotes → MidiPianoRoll):
// {
//   durationSec, minMidi, maxMidi,
//   notes: [{ id, midi, startSec, durationSec, velocity, track, name }],
//   tracks: [{ index, name?, noteCount }],
//   tempos: [{ timeSec, bpm }],
// }

import { midiNoteName } from './pianoKeyboard.js';

const DEFAULT_TEMPO_US = 500000; // 120 BPM — the SMF default until a Set Tempo event

/** Read a big-endian uint of `bytes` length at `pos`. */
const readUint = (view, pos, bytes) => {
  let v = 0;
  for (let i = 0; i < bytes; i += 1) v = (v << 8) | view.getUint8(pos + i);
  return v >>> 0;
};

/** Read a MIDI variable-length quantity. Returns { value, next }. */
const readVarLen = (view, pos, end) => {
  let value = 0;
  let p = pos;
  for (let i = 0; i < 4 && p < end; i += 1) {
    const byte = view.getUint8(p);
    p += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: p };
  }
  return { value, next: p };
};

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;
const decodeText = (view, pos, len) => {
  if (!textDecoder) return '';
  return textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + pos, len)).trim();
};

/**
 * Parse one MTrk chunk body into raw tick-timed events.
 * Handles running status, note-on velocity 0 as note-off, and skips
 * sysex/meta payloads it doesn't care about.
 */
const parseTrackEvents = (view, start, end) => {
  const events = []; // { tick, type: 'on'|'off'|'tempo'|'name', ... }
  let pos = start;
  let tick = 0;
  let runningStatus = 0;
  while (pos < end) {
    const delta = readVarLen(view, pos, end);
    tick += delta.value;
    pos = delta.next;
    if (pos >= end) break;

    let status = view.getUint8(pos);
    if (status & 0x80) {
      pos += 1;
    } else {
      // Running status: reuse the previous channel-message status byte.
      if (!(runningStatus & 0x80)) break; // malformed — bail out of this track
      status = runningStatus;
    }

    if (status === 0xff) {
      // Meta event: type byte + varlen payload.
      const metaType = view.getUint8(pos);
      const len = readVarLen(view, pos + 1, end);
      const dataPos = len.next;
      if (metaType === 0x51 && len.value >= 3) {
        events.push({ tick, type: 'tempo', usPerQuarter: readUint(view, dataPos, 3) });
      } else if (metaType === 0x03 && len.value > 0) {
        events.push({ tick, type: 'name', name: decodeText(view, dataPos, len.value) });
      } else if (metaType === 0x2f) {
        pos = dataPos + len.value;
        break; // End of Track
      }
      pos = dataPos + len.value;
      runningStatus = 0; // meta/sysex cancel running status
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const len = readVarLen(view, pos, end);
      pos = len.next + len.value;
      runningStatus = 0;
      continue;
    }

    runningStatus = status;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const dataLen = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
    if (pos + dataLen > end) break;
    if (kind === 0x90 || kind === 0x80) {
      const midi = view.getUint8(pos);
      const velocity = view.getUint8(pos + 1);
      if (kind === 0x90 && velocity > 0) events.push({ tick, type: 'on', midi, velocity, channel });
      else events.push({ tick, type: 'off', midi, channel });
    }
    pos += dataLen;
  }
  return events;
};

/**
 * Build a tick→seconds converter from the file's tempo events.
 * PPQ division uses the piecewise tempo map; SMPTE division is a fixed
 * seconds-per-tick and ignores tempo events entirely (per the SMF spec).
 */
const buildTickToSec = (division, tempoEvents) => {
  if (division & 0x8000) {
    // SMPTE: high byte is negative frames/sec, low byte is ticks/frame.
    const fps = 256 - ((division >> 8) & 0xff); // two's complement of the negative byte
    const ticksPerFrame = division & 0xff;
    const secPerTick = 1 / (fps * ticksPerFrame || 1);
    return (tick) => tick * secPerTick;
  }
  const ppq = division || 480;
  // Piecewise segments: seconds accumulated up to each tempo change.
  const changes = [...tempoEvents].sort((a, b) => a.tick - b.tick);
  const segments = [];
  let curTick = 0;
  let curSec = 0;
  let curUs = DEFAULT_TEMPO_US;
  changes.forEach((c) => {
    if (c.tick > curTick) {
      curSec += ((c.tick - curTick) * curUs) / (ppq * 1e6);
      curTick = c.tick;
    }
    curUs = c.usPerQuarter;
    segments.push({ tick: curTick, sec: curSec, usPerQuarter: curUs });
  });
  const DEFAULT_BASE = { tick: 0, sec: 0, usPerQuarter: DEFAULT_TEMPO_US };
  return (tick) => {
    // Binary-search the last segment whose tick ≤ the query tick (segments are
    // sorted ascending). Falls back to the SMF default tempo for ticks before
    // the first tempo change. O(log segments) instead of a per-note linear scan
    // — only material for tempo-automation-dense files, but free to get right.
    let lo = 0;
    let hi = segments.length - 1;
    let base = DEFAULT_BASE;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].tick <= tick) { base = segments[mid]; lo = mid + 1; } else { hi = mid - 1; }
    }
    return base.sec + ((tick - base.tick) * base.usPerQuarter) / (ppq * 1e6);
  };
};

/**
 * Parse an SMF file into the piano-roll view-model.
 *
 * @param {ArrayBuffer|Uint8Array} buffer — raw `.mid` bytes.
 * @returns {{ durationSec:number, minMidi:number, maxMidi:number,
 *   notes:Array<{id:string,midi:number,startSec:number,durationSec:number,velocity:number,track:number,name:string}>,
 *   tracks:Array<{index:number,name:string|null,noteCount:number}>,
 *   tempos:Array<{timeSec:number,bpm:number}> }}
 * @throws {Error} when the buffer is not a parseable SMF file.
 */
export const parseMidiFile = (buffer) => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 14 || readUint(view, 0, 4) !== 0x4d546864) {
    throw new Error('Not a MIDI file (missing MThd header)');
  }
  const headerLen = readUint(view, 4, 4);
  const trackCount = readUint(view, 10, 2);
  const division = readUint(view, 12, 2);

  // Walk the MTrk chunks (skip unknown chunk types per the spec).
  const rawTracks = [];
  let pos = 8 + headerLen;
  while (pos + 8 <= bytes.length && rawTracks.length < trackCount) {
    const chunkType = readUint(view, pos, 4);
    const chunkLen = readUint(view, pos + 4, 4);
    const bodyStart = pos + 8;
    const bodyEnd = Math.min(bodyStart + chunkLen, bytes.length);
    if (chunkType === 0x4d54726b) rawTracks.push(parseTrackEvents(view, bodyStart, bodyEnd));
    pos = bodyStart + chunkLen;
  }
  if (!rawTracks.length) throw new Error('MIDI file has no tracks');

  const tempoEvents = rawTracks.flat().filter((e) => e.type === 'tempo');
  const tickToSec = buildTickToSec(division, tempoEvents);

  const notes = [];
  const tracks = [];
  rawTracks.forEach((events, trackIndex) => {
    // Keyed per channel+pitch so a multi-channel format-0 file can't have one
    // channel's note-off truncate a same-pitch note held on another channel.
    const open = new Map(); // (channel<<8)|midi → { startTick, velocity } (last-on wins)
    let name = null;
    let noteCount = 0;
    events.forEach((ev) => {
      if (ev.type === 'name' && !name) name = ev.name;
      if (ev.type !== 'on' && ev.type !== 'off') return;
      const key = ((ev.channel || 0) << 8) | ev.midi;
      if (ev.type === 'on') {
        // Retrigger of an already-open pitch closes the previous note first.
        const prev = open.get(key);
        if (prev) pushNote(prev, ev.tick);
        open.set(key, { midi: ev.midi, startTick: ev.tick, velocity: ev.velocity });
      } else {
        const prev = open.get(key);
        if (prev) { pushNote(prev, ev.tick); open.delete(key); }
      }
    });
    // Notes left open at end-of-track get a minimal duration instead of vanishing.
    open.forEach((prev) => pushNote(prev, prev.startTick + 1));

    function pushNote(prev, endTick) {
      const startSec = tickToSec(prev.startTick);
      const endSec = tickToSec(Math.max(endTick, prev.startTick + 1));
      notes.push({
        id: `${trackIndex}:${notes.length}`,
        midi: prev.midi,
        startSec,
        durationSec: Math.max(endSec - startSec, 0.001),
        velocity: prev.velocity / 127,
        track: trackIndex,
        name: midiNoteName(prev.midi),
      });
      noteCount += 1;
    }
    tracks.push({ index: trackIndex, name, noteCount });
  });

  notes.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  let durationSec = 0;
  let minMidi = 127;
  let maxMidi = 0;
  notes.forEach((n) => {
    durationSec = Math.max(durationSec, n.startSec + n.durationSec);
    minMidi = Math.min(minMidi, n.midi);
    maxMidi = Math.max(maxMidi, n.midi);
  });
  if (!notes.length) { minMidi = 60; maxMidi = 71; }

  return {
    durationSec,
    minMidi,
    maxMidi,
    notes,
    tracks: tracks.filter((t) => t.noteCount > 0 || tracks.length === 1),
    tempos: tempoEvents
      .sort((a, b) => a.tick - b.tick)
      .map((e) => ({ timeSec: tickToSec(e.tick), bpm: Math.round(60e6 / e.usPerQuarter) })),
  };
};
