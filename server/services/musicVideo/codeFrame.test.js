import { describe, expect, it } from 'vitest';
import { buildCodeDocument } from './codeComposition.js';
import { _sampleFrame } from './codeFrame.js';
import { buildSongDocument, paletteFromProject } from './codeTimeline.js';

const fixtureSectionSource = (color) => `function render(ctx, env) {\n  ctx.fillStyle = ${JSON.stringify(color)};\n  ctx.fillRect(env.safe.x, env.safe.y, 12 + (env.frame % 3), 12);\n}`;

function samePixels(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function embeddedSong(html) {
  const marker = 'const SONG = ';
  const start = html.indexOf(marker);
  const jsonStart = start + marker.length;
  const end = html.indexOf(';\n', jsonStart);
  return JSON.parse(html.slice(jsonStart, end));
}

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
  return _sampleFrame({
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
    const sources = { a: fixtureSectionSource('#2244aa'), b: fixtureSectionSource('#aa4422') };
    const before = frameAt(sources, 0.19);
    const helloEarly = before.karaoke.flatMap((line) => line.words).find((word) => word.text === 'hello');
    expect(helloEarly.highlight).toBe(false);
    expect(frameAt(sources, 1.7).karaoke).toEqual([]);
    const painted = frameAt(sources, 0.5);
    const hello = painted.karaoke.flatMap((line) => line.words).find((word) => word.text === 'hello');
    expect(hello.highlight).toBe(true);
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

it('executes authored functions and legacy statement bodies with runtime string compilation disabled', async () => {
  const { runInNewContext } = await import('node:vm');
  const song = { durationSec: 2, sections: [
    { id: 'first', startSec: 0, endSec: 1 }, { id: 'second', startSec: 1, endSec: 2 },
  ], lyrics: [] };
  const { html } = buildCodeDocument({ song, palette: { background: '#000000', accent: '#ffffff' },
    sources: {
      first: "function render(ctx, env) { ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, env.width, env.height); }",
      second: "ctx.fillStyle = '#abcdef'; ctx.fillRect(0, 0, env.width, env.height);",
    }, width: 32, height: 18, fps: 24 });
  const painted = [];
  const ctx = { fillRect() { painted.push(this.fillStyle); } };
  const sandbox = {
    document: { getElementById: () => ({ getContext: () => ctx }) },
    addEventListener() {}, parent: { postMessage() {} },
  };
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  runInNewContext(script, sandbox, { contextCodeGeneration: { strings: false, wasm: false }, timeout: 1000 });
  expect(painted.at(-1)).toBe('#123456');
  sandbox.portosComposition.seek(1.25);
  expect(painted.at(-1)).toBe('#abcdef');
  sandbox.portosComposition.seek(0);
  expect(painted.at(-1)).toBe('#123456');
  expect(html).not.toContain('new Function');
});

it('rejects section source that would escape the static function/script or use a network call', () => {
  const input = { song: { durationSec: 1 }, palette: {}, width: 32, height: 18, fps: 24 };
  for (const source of [
    "function render(ctx, env) {} }; globalThis.compromised = true; (function () {",
    "function render(ctx, env) { ctx.fillText('</ScRiPt><script>bad()', 0, 0); }",
    "function render(ctx, env) { /* <!-- */ }",
  ]) {
    expect(() => buildCodeDocument({ ...input, sources: { section: source } })).toThrow(expect.objectContaining({ code: 'INVALID_SECTION_SOURCE' }));
  }
  expect(() => buildCodeDocument({ ...input, sources: { section: "fetch('https://example.com')" } }))
    .toThrow(expect.objectContaining({ code: 'NONDETERMINISTIC_SECTION' }));
});
