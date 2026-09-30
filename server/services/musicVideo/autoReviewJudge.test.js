import { describe, it, expect } from 'vitest';
import { MAX_REVIEW_IMAGES, SHEET_TILES, buildAutoReviewPrompt, planStripTimes } from './autoReviewJudge.js';

const sections = (n, span) => Array.from({ length: n }, (_, i) => ({ startSec: (i * span) / n, endSec: ((i + 1) * span) / n }));

describe('planStripTimes (#9272)', () => {
  it('samples at least one frame inside every section of a long, many-shot edit', () => {
    const secs = sections(65, 204);
    const times = planStripTimes(204, secs);
    expect(times.length).toBeGreaterThanOrEqual(65);
    for (const s of secs) expect(times.some((t) => t >= s.startSec && t <= s.endSec)).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('keeps a short excerpt at 12 frames', () => {
    expect(planStripTimes(20, sections(5, 20))).toHaveLength(12);
  });

  it('never needs more than the reviewer image cap once tiled', () => {
    for (const hasContactSheet of [false, true]) {
      const times = planStripTimes(900, sections(200, 900), { hasContactSheet });
      expect(Math.ceil(times.length / SHEET_TILES) + (hasContactSheet ? 1 : 0)).toBeLessThanOrEqual(MAX_REVIEW_IMAGES);
      expect(times.every((t) => t >= 0 && t <= 900)).toBe(true);
    }
  });

  it('lists every tile time in the prompt so findings stay timecoded', () => {
    const prompt = buildAutoReviewPrompt({ spanSec: 20, sections: sections(2, 20), frameTimes: [1.5, 12], tiled: true });
    expect(prompt).toContain('1.50s, 12.00s');
    expect(prompt).toContain('contact sheets');
  });
});
