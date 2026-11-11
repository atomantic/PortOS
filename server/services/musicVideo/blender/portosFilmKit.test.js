/**
 * The `portos_film` helpers a Blender film imports (py/portos_film/music.py and
 * timing.py) are pure standard-library Python, so they are checked in a plain
 * interpreter (no Blender needed). They are the film-facing half of the song
 * contract: a wrong beat lookup or envelope sample would put every authored
 * film off the music.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync } from '../../../lib/childProcess.js';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../../../lib/testHelper.js';

const PY_DIR = fileURLToPath(new URL('./py/', import.meta.url));
const python = resolveTestPython();

const song = {
  durationSec: 20,
  analysis: {
    beats: [1, 2, 3, 4], downbeats: [1],
    sections: [{ label: 'Intro', startSec: 0, endSec: 2.5, energy: 0.2 }, { label: 'Chorus', startSec: 2.5, endSec: 20, energy: 0.9 }],
    features: { envelopes: { fps: 2, rms: [0.1, 0.2, 0.3], low: [0, 1, 0.5], mid: [], high: [0.4] } },
  },
  lyrics: { cues: [
    { index: 0, text: 'An example line', words: [{ w: 'An', startSec: 12.5, endSec: 12.9 }, { w: 'example', startSec: 12.9, endSec: 13.8 }, { w: 'line', startSec: 13.8, endSec: 14.5 }] },
    { index: 1, text: 'Untimed', words: [] },
  ] },
};

const SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
from portos_film import music, timing
song = json.loads(sys.argv[2])
empty = {}
r = lambda value: round(value, 4)
print(json.dumps({
    "beats_between": music.beats_between(song, 1.5, 3.5),
    "nearest": [music.nearest_beat(song, 2.4), music.nearest_beat(song, 2.6), music.nearest_beat(song, 99), music.nearest_beat(empty, 1)],
    "phase": [list(music.beat_phase(song, 2.5)), list(music.beat_phase(song, 0.5)), list(music.beat_phase(empty, 3))],
    "pulse": [r(music.pulse(song, 2.0, decay=2)), r(music.pulse(song, 2.5, decay=2)), music.pulse(empty, 2.0)],
    "envelope": [r(music.envelope(song, "low", 0.25)), r(music.envelope(song, "low", 0.5)), r(music.envelope(song, "low", 10)),
                 music.envelope(song, "mid", 1), r(music.envelope(song, "high", 3)), music.envelope(song, "nope", 1), music.envelope(empty, "low", 1)],
    "section": [music.section_at(song, 2.4)["label"], music.section_at(song, 2.5)["label"], music.section_at(song, 30)],
    "words": [[w["w"], w["cue"]] for w in music.words_between(song, 12.5, 13.8)],
    "cue_words": [len(music.cue_words(song, 0)), music.cue_words(song, 1), music.cue_words(song, 9)],
    "clamp": [timing.clamp(1.5), timing.clamp(-2), timing.clamp(5, 0, 10)],
    "remap": [timing.remap(5, 0, 10, 0, 100), timing.remap(15, 0, 10, 0, 100), timing.remap(15, 0, 10, 0, 100, clamped=False), timing.remap(1, 3, 3)],
    "ease": [timing.ease(0.5), r(timing.ease(0.25, "in", 2)), r(timing.ease(0.25, "out", 2)), timing.ease(0.25, "linear"), timing.ease(2), r(timing.ease(0.5, "smooth"))],
    "stepped": [r(timing.stepped(0.99, 24, 2)), r(timing.stepped(1.0, 24, 2)), r(timing.stepped(0.99, 24, 1))],
}))
`;

describe.skipIf(!python)('portos_film kit', () => {
  it('reads beats, sections, envelopes and timed words off the song, and eases and steps time', () => {
    const out = JSON.parse(execFileSync(python, ['-c', SCRIPT, PY_DIR, JSON.stringify(song)], { encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS }));
    expect(out).toEqual({
      beats_between: [2, 3],
      nearest: [2, 3, 4, null],
      // (last beat index, how far to the next); before the first beat and without a grid it is the start of beat 0.
      phase: [[1, 0.5], [0, 0], [0, 0]],
      pulse: [1, 0.25, 0],
      // Interpolated between analysis frames, held at the last one, and 0 for a band that is missing or empty.
      envelope: [0.5, 1, 0.5, 0, 0.4, 0, 0],
      section: ['Intro', 'Chorus', null],
      words: [['An', 0], ['example', 0]],
      cue_words: [3, [], []],
      clamp: [1, 0, 5],
      remap: [50, 100, 150, 0],
      ease: [0.5, 0.0625, 0.4375, 0.25, 1, 0.5],
      // On twos at 24 fps a pose holds for 1/12 s.
      stepped: [0.9167, 1, 0.9583],
    });
  }, PY_TEST_TIMEOUT_MS);
});
