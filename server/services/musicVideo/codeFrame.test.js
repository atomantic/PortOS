import { describe, expect, it } from 'vitest';
import { buildCodeDocument, embeddedSong } from './codeComposition.js';
import { CODE_EARLY_DIM_SEC, fixtureSectionSource, lineActive, sampleFrame, samePixels, wordAppearance } from './codeFrame.js';
import { buildSongDocument, paletteFromProject } from './codeTimeline.js';

const project = {
  audioAnalysis: {
    durationSec: 2,
    beats: [0, 0.5, 1, 1.5],
    downbeats: [0, 1],
    sections: [
      { id: 'a', label: 'A', startSec: 0, endSec: 1 },
      { id: 'b', label: 'B', startSec: 1, endSec: 2 },
    ],
  },
  lyricCues: [{ id: 'line', text: 'hello </script>', startSec: 0.2, endSec: 1.6, words: [
    { text: 'hello', startSec: 0.2, endSec: 0.6 },
    { text: 'there', startSec: 0.8, endSec: 1.4 },
  ] }],
  visualSpec: { palette: ['#101010', '#f0f0f0', '#ff8800'] },
  composition: { style: { font: 'sans' } },
};

function frameAt(sources, t) {
  const song = buildSongDocument(project);
  return sampleFrame({
    song, palette: paletteFromProject(project), sources, t, width: 320, height: 180, fps: song.fps,
  });
}

describe('code frame contract (#9076)', () => {
  it('seeks the same t twice to identical pixels, including inside one frame', () => {
    const sources = { a: fixtureSectionSource('#2244aa'), b: fixtureSectionSource('#aa4422') };
    const first = frameAt(sources, 0.5);
    const second = frameAt(sources, 0.5);
    expect(samePixels(first.data, second.data)).toBe(true);
    const later = frameAt(sources, 0.5 + 0.01);
    expect(later.frame).toBe(first.frame);
    expect(samePixels(first.data, later.data)).toBe(true);
  });

  it('regenerating one section leaves the other section pixels unchanged', () => {
    const before = { a: fixtureSectionSource('#2244aa'), b: fixtureSectionSource('#aa4422') };
    const after = { ...before, a: fixtureSectionSource('#00ff00') };
    expect(samePixels(frameAt(before, 1.25).data, frameAt(after, 1.25).data)).toBe(true);
    expect(samePixels(frameAt(before, 0.3).data, frameAt(after, 0.3).data)).toBe(false);
  });

  it('highlights a word only at its start and keeps the line inside the safe area', () => {
    const word = { text: 'hello', startSec: 0.2, endSec: 0.6 };
    expect(wordAppearance(word, 0.2 - CODE_EARLY_DIM_SEC - 0.05).opacity).toBe(0);
    expect(wordAppearance(word, 0.2 - 0.01).highlight).toBe(false);
    expect(wordAppearance(word, 0.2).highlight).toBe(true);
    const song = buildSongDocument(project);
    const line = song.lyrics[0];
    expect(lineActive(line, 0.5)).toBe(true);
    const painted = frameAt({ a: fixtureSectionSource('#2244aa'), b: fixtureSectionSource('#aa4422') }, 0.5);
    expect(painted.textOps.map((op) => op.text)).toEqual(expect.arrayContaining(['hello', 'there']));
    const safe = { x: 320 * 0.1, y: 180 * 0.1, w: 320 * 0.8, h: 180 * 0.8 };
    for (const op of painted.textOps) {
      expect(op.x).toBeGreaterThanOrEqual(safe.x - 0.5);
      expect(op.x).toBeLessThanOrEqual(safe.x + safe.w + 0.5);
      expect(op.y).toBeLessThanOrEqual(safe.y + safe.h + 0.5);
    }
    const there = painted.textOps.find((op) => op.text === 'there');
    expect(there).toBeTruthy();
  });

  it('inlines song.json and escapes a lyric that could close the script', () => {
    const song = buildSongDocument(project);
    const doc = buildCodeDocument({
      song, palette: paletteFromProject(project), sources: {}, width: 320, height: 180, fps: 24,
    });
    expect(embeddedSong(doc.html)).toEqual(song);
    expect(doc.html).toContain('\\u003c/script>');
    expect(doc.html.split('</script>')).toHaveLength(2);
    expect(doc.html).toContain('portosComposition');
    expect(doc.html).toContain('mv-code:seek');
  });
});
