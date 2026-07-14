import { describe, expect, it } from 'vitest';
import { parseMidiFile } from './midiNotes.js';

// Hand-built SMF fixtures — tiny byte arrays, no real transcriptions
// (Sensitive Data rule: never commit personal project data as fixtures).

const PPQ = 480;

/** Encode a MIDI variable-length quantity. */
const varLen = (value) => {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
};

const str = (s) => [...s].map((c) => c.charCodeAt(0));
const u32 = (v) => [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];

const track = (events) => {
  const body = events.flat();
  return [...str('MTrk'), ...u32(body.length), ...body];
};

const smf = (tracks, { format = 1, division = PPQ } = {}) => new Uint8Array([
  ...str('MThd'), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(division),
  ...tracks.flat(),
]);

const noteOn = (delta, midi, vel = 100, ch = 0) => [...varLen(delta), 0x90 | ch, midi, vel];
const noteOff = (delta, midi, ch = 0) => [...varLen(delta), 0x80 | ch, midi, 0];
const tempoEv = (delta, usPerQuarter) => [...varLen(delta), 0xff, 0x51, 0x03,
  (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff];
const trackNameEv = (delta, name) => [...varLen(delta), 0xff, 0x03, name.length, ...str(name)];
const endOfTrack = (delta = 0) => [...varLen(delta), 0xff, 0x2f, 0x00];

describe('parseMidiFile', () => {
  it('rejects non-MIDI bytes', () => {
    expect(() => parseMidiFile(new Uint8Array([1, 2, 3, 4]))).toThrow(/MThd/);
    expect(() => parseMidiFile(new Uint8Array(str('RIFFxxxxWAVE')).buffer)).toThrow(/MThd/);
  });

  it('parses notes with default-tempo timing (120 BPM → one beat = 0.5s)', () => {
    const bytes = smf([track([
      noteOn(0, 60),
      noteOff(PPQ, 60),      // C4 for one quarter
      noteOn(0, 64, 64),
      noteOff(PPQ * 2, 64),  // E4 for a half note
      endOfTrack(),
    ])]);
    const vm = parseMidiFile(bytes);
    expect(vm.notes).toHaveLength(2);
    const [c4, e4] = vm.notes;
    expect(c4).toMatchObject({ midi: 60, name: 'C4', track: 0 });
    expect(c4.startSec).toBeCloseTo(0, 5);
    expect(c4.durationSec).toBeCloseTo(0.5, 5);
    expect(e4.startSec).toBeCloseTo(0.5, 5);
    expect(e4.durationSec).toBeCloseTo(1.0, 5);
    expect(e4.velocity).toBeCloseTo(64 / 127, 5);
    expect(vm.durationSec).toBeCloseTo(1.5, 5);
    expect(vm.minMidi).toBe(60);
    expect(vm.maxMidi).toBe(64);
  });

  it('applies mid-file tempo changes to later notes only', () => {
    const bytes = smf([track([
      tempoEv(0, 500000),        // 120 BPM
      noteOn(0, 60), noteOff(PPQ, 60),   // 0.0–0.5s
      tempoEv(0, 250000),        // 240 BPM from tick 480
      noteOn(0, 62), noteOff(PPQ, 62),   // starts 0.5s, lasts 0.25s
      endOfTrack(),
    ])]);
    const vm = parseMidiFile(bytes);
    const d4 = vm.notes.find((n) => n.midi === 62);
    expect(d4.startSec).toBeCloseTo(0.5, 5);
    expect(d4.durationSec).toBeCloseTo(0.25, 5);
    expect(vm.tempos.map((t) => t.bpm)).toEqual([120, 240]);
  });

  it('resolves tick→seconds across several tempo segments (binary-search picks the right one)', () => {
    const bytes = smf([track([
      tempoEv(0, 500000),                 // tick 0   → 120 BPM (0.5s/beat)
      noteOn(0, 60), noteOff(PPQ, 60),    // tick 0..480   → 0.00s
      tempoEv(0, 250000),                 // tick 480 → 240 BPM (0.25s/beat)
      noteOn(0, 62), noteOff(PPQ, 62),    // tick 480..960 → 0.50s
      tempoEv(0, 1000000),                // tick 960 → 60 BPM (1.0s/beat)
      noteOn(0, 64), noteOff(PPQ, 64),    // tick 960..1440 → 0.75s, lasts 1.0s
      noteOn(0, 65), noteOff(PPQ, 65),    // tick 1440..1920 → 1.75s
      endOfTrack(),
    ])]);
    const vm = parseMidiFile(bytes);
    const at = (midi) => vm.notes.find((n) => n.midi === midi);
    expect(at(60).startSec).toBeCloseTo(0.0, 5);
    expect(at(62).startSec).toBeCloseTo(0.5, 5);
    expect(at(64).startSec).toBeCloseTo(0.75, 5);
    expect(at(64).durationSec).toBeCloseTo(1.0, 5);
    expect(at(65).startSec).toBeCloseTo(1.75, 5); // last segment (60 BPM) applied
    expect(vm.tempos.map((t) => t.bpm)).toEqual([120, 240, 60]);
  });

  it('treats note-on velocity 0 as note-off and supports running status', () => {
    // After the first 0x90, subsequent events omit the status byte entirely.
    const bytes = smf([track([
      [...varLen(0), 0x90, 60, 100],
      [...varLen(PPQ), 60, 0],        // running status: vel-0 note-on = off
      [...varLen(0), 64, 80],         // running status: new note-on
      [...varLen(PPQ), 64, 0],
      endOfTrack(),
    ])]);
    const vm = parseMidiFile(bytes);
    expect(vm.notes).toHaveLength(2);
    expect(vm.notes[0].durationSec).toBeCloseTo(0.5, 5);
    expect(vm.notes[1].startSec).toBeCloseTo(0.5, 5);
  });

  it('separates tracks, keeps names, and counts notes per track', () => {
    const bytes = smf([
      track([tempoEv(0, 500000), endOfTrack()]), // conductor track — no notes
      track([trackNameEv(0, 'Piano'), noteOn(0, 60), noteOff(PPQ, 60), endOfTrack()]),
      track([trackNameEv(0, 'Bass'), noteOn(0, 40), noteOff(PPQ, 40), endOfTrack()]),
    ]);
    const vm = parseMidiFile(bytes);
    expect(vm.tracks.map((t) => t.name)).toEqual(['Piano', 'Bass']);
    expect(vm.tracks.every((t) => t.noteCount === 1)).toBe(true);
    expect(new Set(vm.notes.map((n) => n.track)).size).toBe(2);
  });

  it('pairs note-off per channel — one channel cannot truncate another channel\'s same pitch', () => {
    // C4 held on ch0 for two beats; C4 on ch1 starts and ends within it.
    const bytes = smf([track([
      noteOn(0, 60, 100, 0),
      noteOn(0, 60, 80, 1),
      noteOff(PPQ, 60, 1),      // ch1 off at one beat — must NOT close ch0's note
      noteOff(PPQ, 60, 0),      // ch0 off at two beats
      endOfTrack(),
    ])]);
    const vm = parseMidiFile(bytes);
    expect(vm.notes).toHaveLength(2);
    const durations = vm.notes.map((n) => n.durationSec).sort((a, b) => a - b);
    expect(durations[0]).toBeCloseTo(0.5, 5);
    expect(durations[1]).toBeCloseTo(1.0, 5);
  });

  it('closes notes left open at end-of-track instead of dropping them', () => {
    const bytes = smf([track([noteOn(0, 72), endOfTrack(PPQ)])]);
    const vm = parseMidiFile(bytes);
    expect(vm.notes).toHaveLength(1);
    expect(vm.notes[0].durationSec).toBeGreaterThan(0);
  });

  it('skips sysex and unknown meta events without derailing note parsing', () => {
    const bytes = smf([track([
      [...varLen(0), 0xf0, 3, 1, 2, 0xf7],      // sysex, length 3
      [...varLen(0), 0xff, 0x58, 4, 4, 2, 24, 8], // time signature meta
      noteOn(0, 60), noteOff(PPQ, 60),
      endOfTrack(),
    ])]);
    expect(parseMidiFile(bytes).notes).toHaveLength(1);
  });

  it('handles an empty note list without NaN ranges', () => {
    const bytes = smf([track([endOfTrack()])]);
    const vm = parseMidiFile(bytes);
    expect(vm.notes).toHaveLength(0);
    expect(vm.durationSec).toBe(0);
    expect(Number.isFinite(vm.minMidi)).toBe(true);
    expect(Number.isFinite(vm.maxMidi)).toBe(true);
  });
});
