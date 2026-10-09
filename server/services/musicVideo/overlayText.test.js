/**
 * The overlay text verdicts on synthetic probe records: which drawn words form
 * one block, when blocks collide, when an outline carries contrast, and how a
 * line revealed word by word stays one finding. The browser suite
 * (overlayTextService.browser.test.js) drives the same code from real pixels.
 */
import { describe, expect, it } from 'vitest';
import {
  OVERLAY_TEXT_PROCESS_ID, analyzeTextFrame, mergeTextRecords, overlayTextReport, planTextSampleTimes, summarizeTextFindings,
} from './overlayText.js';

const FRAME = { width: 1920, height: 1080 };
const CREAM = '#f3ead7';
const INK = '#141217';
const PALE = { p15: 0.8, p50: 0.82, p85: 0.86 };

// One word as the probe reports it: fill (and optional outline) at a box, em px from the font.
function word(text, x0, y0, { w = text.length * 40, h = 70, em = 96, font = '900 96px Archivo', fill = CREAM, outline = 0, alpha = 1, layer = 'canvas-0' } = {}) {
  const box = { text, layer, source: 'canvas', font, emPx: em, x0, y0, x1: x0 + w, y1: y0 + h, alpha, shadow: null };
  return [
    ...(outline ? [{ ...box, kind: 'stroke', color: INK, lineWidth: outline }] : []),
    { ...box, kind: 'fill', color: fill, lineWidth: 0 },
  ];
}
const frameIssues = (records, backdrop = null) => {
  const items = mergeTextRecords(records);
  if (backdrop) for (const item of items) item.backdrop = backdrop;
  return analyzeTextFrame(items, FRAME);
};

describe('analyzeTextFrame', () => {
  it('flags a readout under a lyric, but not the words of one line touching each other', () => {
    const line = [...word('WHOLE', 700, 60, { outline: 14 }), ...word('SPECIES', 950, 60, { outline: 14 })];
    const readout = word('20 MILLION YEARS', 40, 80, { font: '500 40px Plex Mono', em: 40, w: 700, h: 32 });
    expect(frameIssues(line)).toEqual([]);
    expect(frameIssues([...readout, ...line])).toEqual([{ kind: 'overlap', texts: ['20 MILLION YEARS', 'WHOLE SPECIES'], detail: null }]);
  });

  it('ignores a word mid-fade for collisions', () => {
    const fading = word('OLD LINE', 100, 900, { alpha: 0.2, w: 500 });
    const incoming = word('NEW LINE', 120, 910, { font: '700 68px Archivo', em: 68, w: 500 });
    expect(frameIssues([...fading, ...incoming])).toEqual([]);
  });

  it('flags text past the edge and text too small for a phone', () => {
    expect(frameIssues(word('OFF THE EDGE', 1700, 900, { w: 400 })).map((i) => i.kind)).toEqual(['off-frame']);
    const tag = frameIssues(word('tiny', 100, 100, { em: 30, h: 22, font: '30px sans-serif' }));
    expect(tag).toEqual([{ kind: 'small', texts: ['tiny'], detail: { phoneEmPx: 6.1 } }]);
  });

  it('passes cream type on a pale frame only when its ink outline reads at phone size', () => {
    expect(frameIssues(word('BLOOM', 100, 400, { outline: 14 }), PALE)).toEqual([]);
    // A 2px outline is a fraction of a pixel on a phone.
    expect(frameIssues(word('BLOOM', 100, 400, { outline: 2 }), PALE)).toEqual([
      { kind: 'contrast', texts: ['BLOOM'], detail: expect.objectContaining({ outlined: true }) }]);
    expect(frameIssues(word('BLOOM', 100, 400), PALE)[0]).toMatchObject({ kind: 'contrast', detail: { outlined: false } });
    // Dark ink on the same pale frame needs no outline.
    expect(frameIssues(word('BLOOM', 100, 400, { fill: INK }), PALE)).toEqual([]);
  });
});

describe('summarizeTextFindings', () => {
  it('keeps a line revealed word by word as one finding with its fullest text, errors first', () => {
    const contrast = (text) => ({ kind: 'contrast', texts: [text], detail: { ratio: 1.1, needed: 3, outlined: false } });
    const findings = summarizeTextFindings([
      { atSec: 2.5, issues: [contrast('whole')] },
      { atSec: 3.5, issues: [contrast('whole species bloom')] },
      { atSec: 6, issues: [{ kind: 'overlap', texts: ['20 MILLION', 'WHOLE'], detail: null }] },
      { atSec: 20, issues: [contrast('whole species')] },
      { atSec: 30, issues: [contrast('whole')] },
    ], [{ sceneId: 's1', label: 'Cliff', startSec: 0, endSec: 10 }, { sceneId: 's2', label: 'Space', startSec: 10, endSec: 40 }]);
    expect(findings.map((f) => [f.kind, f.texts, f.atSec, f.times, f.sceneLabel])).toEqual([
      ['overlap', ['20 MILLION', 'WHOLE'], 6, [6], 'Cliff'],
      // The exact same text again later (a repeated chorus) joins it; a partial reading only nearby.
      ['contrast', ['whole species bloom'], 2.5, [2.5, 3.5, 30], 'Cliff'],
      ['contrast', ['whole species'], 20, [20], 'Space'],
    ]);
    expect(findings[1].message).toContain('“whole species bloom”');
  });
});

describe('planTextSampleTimes', () => {
  it('samples each line settled, long lines again, each shot, and the first frame of each word, on the frame grid', () => {
    const times = planTextSampleTimes({
      lyrics: [{ startSec: 1, endSec: 4, words: [{ startSec: 1 }, { startSec: 2.02 }] }],
      scenes: [{ startSec: 0, endSec: 8 }],
      durationSec: 8, fps: 24,
    });
    // 1 and 2.042 are entrance frames (a slam-in is largest there), kept however close to a settled sample.
    expect(times).toEqual([0.25, 1, 1.333, 2.042, 2.5, 3.792, 4]);
    expect(times.every((t) => Math.abs(t * 24 - Math.round(t * 24)) < 0.05)).toBe(true);
    const many = planTextSampleTimes({ scenes: Array.from({ length: 300 }, (_, i) => ({ startSec: i, endSec: i + 1 })), durationSec: 300, maxSamples: 50 });
    expect(many).toHaveLength(50);
  });
});

describe('overlayTextReport', () => {
  const project = (textCheck) => ({ composition: { mode: 'document', document: { directory: 'music-video/mv-1/composition/doc-1' } }, productionReview: { textCheck } });
  it('reports nothing outside document mode, and a check another process left running as interrupted', () => {
    expect(overlayTextReport({ composition: { mode: 'concat' } }, () => 'b')).toBeNull();
    expect(overlayTextReport(project(undefined), () => 'b')).toMatchObject({ status: 'none', current: false });
    expect(overlayTextReport(project({ status: 'running', basis: 'b', processId: OVERLAY_TEXT_PROCESS_ID }), () => 'b')).toMatchObject({ status: 'running', current: true });
    expect(overlayTextReport(project({ status: 'running', basis: 'b', processId: 'previous-process' }), () => 'b')).toMatchObject({ status: 'interrupted' });
    expect(overlayTextReport(project({ status: 'complete', basis: 'old', findings: [{ kind: 'overlap', severity: 'error' }] }), () => 'b'))
      .toMatchObject({ status: 'complete', current: false, counts: { errors: 1, overlap: 1 } });
  });
});
