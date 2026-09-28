import { describe, expect, it } from 'vitest';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { normalizeComposition } from './composition.js';
import { buildCodeTimeline, buildSongDocument, quantizeSongDuration } from './codeTimeline.js';

const fixtureSectionSource = (color) => `function render(ctx, env) {\n  ctx.fillStyle = ${JSON.stringify(color)};\n  ctx.fillRect(env.safe.x, env.safe.y, 12 + (env.frame % 3), 12);\n}`;

const project = {
  name: 'Click',
  audioAnalysis: {
    durationSec: 4,
    beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    downbeats: [0, 2],
    sections: [
      { label: 'Verse', startSec: 0, endSec: 2 },
      { label: 'Chorus', startSec: 2, endSec: 4 },
    ],
  },
  lyricCues: [
    { id: 'l1', text: 'hello world', startSec: 0.55, endSec: 1.4 },
    { id: 'l2', text: 'second line', startSec: 2.2, endSec: 3.2, words: [
      { text: 'second', startSec: 2.25, endSec: 2.6 },
      { text: 'line', startSec: 2.7, endSec: 3.1 },
    ] },
  ],
  scenes: [{ sceneId: 's1', label: 'Shot', startSec: 0, endSec: 4, takes: [{ id: 'take-1' }] }],
  composition: { mode: 'concat', textCues: [{ id: 'c1', text: 'kept', startSec: 1, endSec: 2 }], style: { color: '#ffffff', font: 'sans' } },
};

describe('buildCodeTimeline (#9076)', () => {
  it('snaps later section boundaries to the beat at or before the first word', () => {
    const timeline = buildCodeTimeline(project);
    expect(timeline.sections.map((section) => [section.label, section.startSec, section.endSec])).toEqual([
      ['Verse', 0, 2],
      ['Chorus', 2, 4],
    ]);
    for (const section of timeline.sections.slice(1)) {
      expect(timeline.beats).toContain(section.startSec);
    }
    const song = buildSongDocument(project, timeline);
    const chorus = song.lyrics.find((line) => line.id === 'l2');
    expect(chorus.words.map((word) => word.text)).toEqual(['second', 'line']);
    // No word timings: the line itself is the only cue, not invented word times.
    expect(song.lyrics.find((line) => line.id === 'l1').words).toEqual([
      { text: 'hello world', startSec: 0.55, endSec: 1.4 },
    ]);
  });

  it('uses the nearest downbeat when a section has no lyric', () => {
    const instrumental = {
      ...project,
      lyricCues: [],
      audioAnalysis: { ...project.audioAnalysis, sections: [
        { label: 'Intro', startSec: 0, endSec: 2.2 },
        { label: 'Drop', startSec: 2.2, endSec: 4 },
      ] },
    };
    const timeline = buildCodeTimeline(instrumental);
    expect(timeline.sections.map((section) => section.startSec)).toEqual([0, 2]);
    expect(timeline.sections[1].snapKind).toBe('downbeat');
  });

  it('prefers treatment windows over analyzed sections', () => {
    const directed = {
      ...project,
      treatment: { arc: { beats: [
        { id: 'b1', label: 'Open', startSec: 0, endSec: 1.2 },
        { id: 'b2', label: 'Payoff', startSec: 1.2, endSec: 4 },
      ] } },
    };
    const timeline = buildCodeTimeline(directed);
    expect(timeline.sections.map((section) => section.id)).toEqual(['b1', 'b2']);
    expect(timeline.beats).toContain(timeline.sections[1].startSec);
  });

  it('covers the song within one frame', () => {
    for (const duration of [1 / 24, 2, 2.01, 3.333, 10]) {
      const quantized = quantizeSongDuration(duration, 24);
      expect(quantized.durationSec).toBeGreaterThanOrEqual(duration - 1e-9);
      expect(quantized.durationSec - duration).toBeLessThan(1 / 24 + 1e-9);
      expect(Math.round(quantized.durationSec * 24)).toBe(quantized.frames);
    }
  });
});

describe('code mode keeps the rest of the project (#9076)', () => {
  it('defaults unknown modes to concat and round-trips code without dropping cues', () => {
    expect(normalizeComposition({ mode: 'not-a-mode', textCues: [{ text: 'Hi', startSec: 1, endSec: 2 }] }).mode).toBe('concat');
    const source = fixtureSectionSource('#112233');
    const code = normalizeComposition({
      mode: 'code',
      textCues: project.composition.textCues,
      codeVideo: { providerId: 'stub', model: 'fixture', sections: [{ id: 'Verse', source }, { id: 'bad', source: 'Math.random()' }] },
    });
    expect(code.mode).toBe('code');
    expect(code.textCues.map((cue) => cue.text)).toEqual(['kept']);
    expect(code.codeVideo.sections).toEqual([{ id: 'Verse', source }]);
    expect(normalizeComposition({ ...code, mode: 'concat' }).textCues).toHaveLength(1);
    expect(normalizeComposition({ ...code, mode: 'composed' }).codeVideo.sections).toHaveLength(1);
    expect(PORTOS_SCHEMA_VERSIONS.musicVideoProjects).toBe(7);
  });
});
