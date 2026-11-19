import { describe, expect, it } from 'vitest';
import { buildMidiDigest, midiSongSummary, midiWindowFacts } from './musicVideoMidiDigest.js';

// A synthetic transcription (no real song data): an A-minor pad that climbs,
// a bass that stabs hard at 8s and 8.5s, and a kit that only enters at 6s.
const note = (track, midi, startSec, durationSec = 0.4, velocity = 0.5) => ({ track, midi, startSec, durationSec, velocity });
function fixture() {
  const notes = [];
  // Pad chords: Am (A C E) then F (F A C), the top note rising each bar.
  for (let bar = 0; bar < 5; bar += 1) {
    const t = bar * 2;
    const chord = bar % 2 === 0 ? [57, 60, 64] : [53, 57, 60];
    for (const midi of chord) notes.push(note(0, midi + (bar >= 3 ? 12 : 0), t, 1.9));
    notes.push(note(0, 64 + bar * 2, t + 1, 0.5));
  }
  for (let i = 0; i < 10; i += 1) notes.push(note(1, 33, i, 0.4, i === 8 ? 1 : 0.5));
  notes.push(note(1, 33, 8.5, 0.3, 1));
  for (let i = 0; i < 8; i += 1) notes.push(note(2, 36, 6 + i * 0.5, 0.1, 0.6));
  return {
    durationSec: 10,
    notes: notes.sort((a, b) => a.startSec - b.startSec),
    tracks: [
      { index: 0, name: 'Pad', program: 89, drums: false },
      { index: 1, name: null, program: 33, drums: false },
      { index: 2, name: null, program: null, drums: true },
    ],
  };
}

describe('MIDI digest for music video planning', () => {
  it('names the parts by track name, GM family or kit and guesses the key', () => {
    const digest = buildMidiDigest(fixture());
    expect(digest.parts.map((p) => [p.label, p.role])).toEqual(expect.arrayContaining([['pad', 'pitched'], ['bass', 'bass'], ['drums', 'drums']]));
    expect(digest.key).toBe('A minor');
    const summary = midiSongSummary(digest);
    expect(summary).toMatch(/^Audio-to-MIDI transcription of the song \(a machine estimate/);
    expect(summary).toContain('likely key A minor');
  });

  it('describes a span: density, the strong low hits, the top line, chords and the part that enters', () => {
    const digest = buildMidiDigest(fixture());
    const late = midiWindowFacts(digest, 6, 10);
    expect(late).toContain('strong low hits at 8, 8.5s');
    expect(late).toContain('enters: drums');
    expect(late).toMatch(/playing: .*drums/);
    const opening = midiWindowFacts(digest, 0, 4);
    expect(opening).toContain('chords Am → F');
    expect(opening).not.toContain('enters');
    expect(midiWindowFacts(digest, 0, 10)).toMatch(/top line rising/);
  });

  it('says a gap is a break or a held sound, and gives nothing without a digest', () => {
    const digest = buildMidiDigest({ durationSec: 20, notes: [note(0, 60, 0, 8), note(0, 62, 15, 1)], tracks: [] });
    expect(midiWindowFacts(digest, 4, 6)).toBe('transcription: no new notes, a held sound carries over');
    expect(midiWindowFacts(digest, 10, 12)).toBe('transcription: no notes (a break or an untranscribed sound)');
    expect(midiWindowFacts(null, 0, 4)).toBe('');
    expect(midiSongSummary(null)).toBe('');
    expect(buildMidiDigest({ notes: [] })).toBeNull();
  });
});
