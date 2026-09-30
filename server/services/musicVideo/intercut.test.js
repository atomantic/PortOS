/**
 * Intercut edit pass (#9290): energy-tiered pieces cut on sung words, host
 * shots keep continuous (synced) time, partner pieces come from unshown
 * cutaway footage, and the result tiles the same timeline inside every source.
 */
import { describe, expect, it } from 'vitest';
import { intercutClips } from './intercut.js';

const bpm = 120; // 0.5 s beats
const beats = Array.from({ length: 80 }, (_, i) => i * 0.5);
const footage = (sceneId, inSec, spanSec, sourceSec, extra = {}) => ({
  sceneId, videoPath: `/v/${sceneId}.mp4`, width: 1280, height: 720, fps: 24, inSec, outSec: inSec + spanSec, duration: spanSec, sourceSec, loop: false, ...extra,
});
const sections = [
  { startSec: 0, endSec: 10, energy: 0.2 },
  { startSec: 10, endSec: 20, energy: 0.9 },
  { startSec: 20, endSec: 30, energy: 0.5 },
];
const spanOf = (list) => list.reduce((sum, c) => sum + (c.outSec - c.inSec), 0);

describe('intercutClips (#9290)', () => {
  const scenes = [
    { sceneId: 'quiet', shotMode: 'cutaway' },
    { sceneId: 'perf', shotMode: 'performance' },
    { sceneId: 'b-roll', shotMode: 'cutaway' },
    { sceneId: 'mid', shotMode: 'cutaway' },
  ];
  const clips = [
    footage('quiet', 0, 10, 10),
    footage('perf', 1.5, 6, 6.2), // a sung take, edit in-point 1.5 s
    footage('b-roll', 0, 4, 10), // 6 s of its take never shown
    footage('mid', 0, 10, 10, { loop: true }),
  ];

  it('cuts loud sections faster than quiet ones and keeps the timeline', () => {
    const out = intercutClips(clips, { scenes, sections, beats, bpm });
    expect(spanOf(out)).toBeCloseTo(spanOf(clips), 2);
    const inRange = (a, b) => out.filter((c, i) => { const t = spanOf(out.slice(0, i)); return t >= a - 1e-6 && t < b - 1e-6; });
    const loud = inRange(10, 20).length;
    const quiet = inRange(0, 10).length;
    const middle = inRange(20, 30).length;
    expect(quiet).toBeLessThanOrEqual(3); // 8-beat tier: ~4 s pieces, no partner in its section
    expect(loud).toBeGreaterThanOrEqual(8); // 2-beat tier: ~1 s pieces
    expect(middle).toBeGreaterThan(quiet);
  });

  it('keeps a performance host in sync and never uses it as a partner', () => {
    const out = intercutClips(clips, { scenes, sections, beats, bpm });
    let t = 0;
    for (const c of out) {
      if (c.sceneId === 'perf') expect(c.inSec).toBeCloseTo(1.5 + (t - 10), 3); // host time == song time
      t += c.outSec - c.inSec;
    }
    expect(out.filter((c) => c.sceneId === 'perf' && c.intercutOf)).toHaveLength(0);
    expect(out.some((c) => c.sceneId === 'b-roll' && c.intercutOf === 'perf')).toBe(true);
  });

  it('plays partner pieces from footage the edit never showed, inside the source', () => {
    const out = intercutClips(clips, { scenes, sections, beats, bpm });
    const partnerPieces = out.filter((c) => c.intercutOf);
    expect(partnerPieces.length).toBeGreaterThan(0);
    const bRoll = partnerPieces.filter((c) => c.sceneId === 'b-roll');
    expect(bRoll[0].inSec).toBeGreaterThanOrEqual(4 - 1e-6); // starts after its own out-point
    for (const c of out) {
      if (c.loop === false) expect(c.outSec).toBeLessThanOrEqual(c.inSec + (c.sourceSec ?? 0) + 0.25 + 1e-6);
    }
  });

  it('prefers a sung word onset near the target cut', () => {
    const one = [footage('perf', 0, 4, 4), footage('b-roll', 0, 4, 10)];
    const loudOnly = [{ startSec: 0, endSec: 8, energy: 1 }, { startSec: 8, endSec: 9, energy: 0 }];
    const out = intercutClips(one, { scenes, sections: loudOnly, beats, bpm, words: [{ startSec: 1.13 }] });
    expect(out[0].outSec - out[0].inSec).toBeCloseTo(1.13, 2);
  });

  it('passes cards through, and does nothing without a beat grid', () => {
    const card = { sceneId: 'card', layer: 'card', inSec: 0, outSec: 12, duration: 12, cardText: 'X', cardColor: '#000000' };
    expect(intercutClips([card], { scenes, sections, beats, bpm })).toEqual([card]);
    expect(intercutClips(clips, { scenes, sections, beats: [], bpm: null })).toBe(clips);
  });

  it('inserts one-beat hook and number cards in loud sections with bounded density and coverage', () => {
    const source = [footage('quiet', 0, 10, 10), footage('perf', 0, 10, 10)];
    const cues = [
      { text: 'Rise rise 198', startSec: 10, endSec: 14, words: [
        { w: 'Rise', startSec: 10.5 }, { w: 'rise', startSec: 11.5 }, { w: '198', startSec: 12.5 },
      ] },
      { text: 'Rise rise 198', startSec: 14, endSec: 18, words: [
        { w: 'Rise', startSec: 14.5 }, { w: 'rise', startSec: 15.5 }, { w: '198', startSec: 16.5 },
      ] },
    ];
    const rankedSections = [{ startSec: 0, endSec: 10, energy: 0 }, { startSec: 10, endSec: 20, energy: 1 }];
    const out = intercutClips(source, { scenes, sections: rankedSections, beats, bpm, lyricCues: cues,
      graphicCards: true, accentColor: '#123456' });
    const cardTimes = [];
    let t = 0;
    for (const clip of out) {
      if (clip.layer === 'card') {
        cardTimes.push(t);
        expect(clip.outSec - clip.inSec).toBeCloseTo(0.5, 3);
        expect(clip.cardText).toMatch(/rise|198/i);
      }
      t += clip.outSec - clip.inSec;
    }
    expect(t).toBeCloseTo(20, 3);
    expect(out.filter((clip) => clip.layer === 'card').map((clip) => clip.cardText)).toEqual(['Rise', '198', 'Rise', '198']);
    expect(cardTimes).toEqual([10.5, 12.5, 14.5, 16.5]);
    expect(cardTimes.every((at, i) => at >= 10 && (i === 0 || at - cardTimes[i - 1] >= 2 - 1e-3))).toBe(true);
    expect(out.filter((clip) => clip.layer === 'card').map((clip) => clip.cardColor))
      .toEqual(out.filter((clip) => clip.layer === 'card').map((_, i) => i % 2 ? '#000000' : '#123456'));
    expect(out.every((clip, i) => i === 0 || clip.layer !== 'card' || out[i - 1].layer !== 'card')).toBe(true);
    expect(intercutClips(source, { scenes, sections: rankedSections, beats, bpm, lyricCues: cues, graphicCards: false })
      .some((clip) => clip.layer === 'card')).toBe(false);
  });

  it('does not place cards in an analysis gap or next to an authored card', () => {
    const authored = { sceneId: 'title', layer: 'card', inSec: 0, outSec: 1, duration: 1,
      cardText: 'TITLE', cardColor: '#000000' };
    const source = [footage('quiet', 0, 10, 10), authored, footage('perf', 0, 9, 9)];
    const cues = [{ text: '1 2 3', startSec: 11, endSec: 16, words: [
      { w: '1', startSec: 11.5 }, { w: '2', startSec: 12.5 }, { w: '3', startSec: 14.5 },
    ] }];
    const out = intercutClips(source, { scenes, sections: [
      { startSec: 0, endSec: 10, energy: 0 }, { startSec: 13, endSec: 20, energy: 1 },
    ], beats, bpm, lyricCues: cues, graphicCards: true });
    expect(spanOf(out)).toBeCloseTo(20, 3);
    expect(out.filter((clip) => clip.layer === 'card').map((clip) => clip.cardText)).toEqual(['TITLE', '3']);
  });
});
